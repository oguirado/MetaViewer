"""One owned VMM and immutable full-RAM points. No campaign dependencies."""
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time
from guest_command_runtime import native_checks as checks
from guest_command_runtime.image import build_initramfs
from guest_command_runtime.schema import Contracts
from guest_command_runtime.wire import FramedSocket, strict_object
from .config import validate


def require(ok,message):
    if not ok:raise RuntimeError(message)


def scope(path,child=None):
    root=Path('/sys/fs/cgroup').resolve(strict=True);cg=Path(path).resolve(strict=True)
    require(root in cg.parents and 'newton-ia.slice' in cg.parts,'dedicated rewind slice')
    require(checks.self_cgroup()=='/'+str(cg.relative_to(root)),'wrong runtime cgroup')
    for key,limit in [('memory.high',6<<30),('memory.max',8<<30),('pids.max',256)]:
        raw=(cg/key).read_text().strip();require(raw.isdecimal() and 0<int(raw)<=limit,'unbounded resource')
    require((cg/'memory.swap.max').read_text().strip()=='0','swap forbidden')
    cpu=(cg/'cpu.max').read_text().split();require(len(cpu)==2 and all(x.isdecimal() for x in cpu) and 0<int(cpu[0])<=2*int(cpu[1]),'CPU bound')
    require(not any(p.is_dir() for p in cg.iterdir()),'nested cgroup unproved')
    members={int(x) for x in (cg/'cgroup.procs').read_text().split()}
    require(members==({os.getpid()}|({child} if child is not None else set())),'foreign cgroup member')


def pin(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    with os.fdopen(fd,'rb') as stream:
        st=os.fstat(stream.fileno());require(stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1,'point custody')
        digest=hashlib.sha256()
        for block in iter(lambda:stream.read(1<<20),b''):digest.update(block)
        end=os.fstat(stream.fileno());named=Path(path).lstat()
        require(all(getattr(st,k)==getattr(end,k)==getattr(named,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode','st_uid','st_nlink')),'point changed')
    return {'device':st.st_dev,'inode':st.st_ino,'bytes':st.st_size,'sha256':digest.hexdigest()}


class Native:
    def __init__(self,config):
        self.config=validate(config);self.root=None;self.process=None;self.pidfd=None;self.start=None
        self.thread=None;self.fences=0;self.counter=None;self.stream=None;self.points={};self.mapped=None;self.staged=set();self.retired=set();self.point_order=0;self.pending_publication={}
        self.boot_token=None;self.nonces=set();self.close_forced=None;self.directory_identity=None;self.ledger=None;self.owner=None;self.base_owner=None;self.seq=0;self.head='0'*64
        self.opened=False;self.closed=False;self.poisoned=False;self.paused=False
        self.abort=threading.Event();self.record_lock=threading.RLock();self.close_lock=threading.RLock()
        self.compatibility=hashlib.sha256(json.dumps({k:v["sha256"] for k,v in self.config["artifacts"].items()},sort_keys=True).encode()).hexdigest()
    def record(self,op,stage,data=None):
        with self.record_lock:return self._record(op,stage,data)
    def _record(self,op,stage,data=None):
        require(not self.poisoned,'ledger poisoned')
        require(not self.abort.is_set() or op=='stop','runtime stopping')
        payload=json.dumps({'op':op,'stage':stage,'data':data or {}},sort_keys=True,separators=(',',':'))
        row={'seq':self.seq+1,'prev':self.head,'payload':payload}
        row['sha256']=hashlib.sha256((str(row['seq'])+'\n'+self.head+'\n'+payload).encode()).hexdigest()
        raw=(json.dumps(row,separators=(',',':'))+'\n').encode()
        try:
            require(self.ledger is not None and os.fstat(self.ledger).st_size+len(raw)<=4<<20,'ledger bound')
            view=memoryview(raw)
            while view:
                n=os.write(self.ledger,view);require(n>0,'ledger short write');view=view[n:]
            os.fsync(self.ledger)
        except BaseException:self.poisoned=True;raise
        self.seq=row['seq'];self.head=row['sha256']
    def evidence(self):
        return {'pid':self.process.pid if self.process else None,'start_ticks':self.start,
            'returncode':self.process.poll() if self.process else None,'forced_cleanup':self.close_forced,'mapped_point':self.mapped,'closed':self.closed}
    def live(self):
        require(self.process is not None and self.process.poll() is None and checks.pid_identity(self.process.pid)==self.start,'native identity unavailable')
        scope(self.config['external_cgroup'],self.process.pid)
    def _drain(self):
        with self.process.stdout as stream:
            for line in iter(lambda:stream.readline(4096),b''):
                for prefix in (b'rewind_fenced counter=',b'rewind_counter value='):
                    if line.startswith(prefix):
                        value=line.strip()[len(prefix):]
                        if value.isdigit():
                            self.counter=int(value)
                            if prefix.startswith(b'rewind_fenced'):self.fences+=1
    def _api(self,method,path,body):
        with self.close_lock:return self._api_locked(method,path,body)
    def _api_locked(self,method,path,body):
        require(not self.abort.is_set(),'runtime stopping');self.live();end=time.monotonic()+self.config['startup_seconds'];native=self
        class HTTP(http.client.HTTPConnection):
            def connect(self):
                self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(checks.remaining(end));self.sock.connect(str(native.root/'api.sock'))
        connection=HTTP('localhost',timeout=checks.remaining(end))
        try:
            connection.request(method,path,json.dumps(body),{'Content-Type':'application/json','Connection':'close'})
            connection.sock.settimeout(checks.remaining(end));response=connection.getresponse();payload=response.read(4097)
            checks.remaining(end);require(response.status==204 and not payload,'native API refused')
        finally:connection.close()
    def _claim_base(self,base):
        fd=os.open(base/'.rewind-owner.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        try:
            st=os.fstat(fd)
            require(stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o600 and st.st_nlink==1 and st.st_size==0,'base lock custody')
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            require({p.name for p in base.iterdir()}=={'.rewind-owner.lock'},'prior runtime requires reconciliation')
        except BaseException:os.close(fd);raise
        self.base_owner=fd
    def allocate(self):
        with self.close_lock:
            require(not self.abort.is_set(),'runtime stopping')
            return self._allocate()
    def _allocate(self):
        require(not self.opened,'allocation cannot replay');self.opened=True
        require(self.config['runtime_admitted'] is True,'runtime not admitted')
        require(platform.system()=='Linux' and platform.machine()=='aarch64','ARM64 Linux required')
        scope(self.config['external_cgroup']);require(checks.available_memory()>=32<<30,'global headroom')
        modes=[line.split()[1] for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('Umask:')]
        require(len(modes)==1 and int(modes[0],8)&0o077==0o077,'private process umask required')
        checks.check_kvm()
        base=checks.runtime_root(self.config['runtime_root']);require(base.stat().st_dev==Path('/dev/shm').stat().st_dev,'RAM filesystem required')
        self._claim_base(base)
        assets={k:checks.pinned_asset(v['path'],v['sha256'],static=k in ('broker','busybox'),kernel=k=='kernel') for k,v in self.config['artifacts'].items()}
        self.root=Path(tempfile.mkdtemp(prefix='rewind-',dir=base));self.root.chmod(0o700);st=self.root.stat();self.directory_identity=(st.st_dev,st.st_ino)
        self.owner=os.open(self.root/'owner.lock',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);fcntl.flock(self.owner,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.ledger=os.open(self.root/'ledger.jsonl',os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        self.record('allocate','intent')
        for name,data in [('fc',assets['engine']),('Image',assets['kernel']),('initrd.gz',build_initramfs(assets['broker'],assets['busybox']))]:
            fd=os.open(self.root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o500 if name=='fc' else 0o400)
            with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
        self.record('allocate','sealed',{'sha256':self._seal_allocation()})
        self.boot_token=secrets.token_hex(32);self._spawn()
        self.record('boot','intent');self._api('PUT','/machine-config',{'mem_size_mib':256,'vcpu_count':1})
        self._api('PUT','/boot-source',{'kernel_image_path':str(self.root/'Image'),'initrd_path':str(self.root/'initrd.gz'),
            'boot_args':'console=ttyS0 reboot=k panic=1 rdinit=/init mv_rewind=1 mv_nonce='+self.boot_token})
        self._api('PUT','/vsock',{'guest_cid':3,'uds_path':str(self.root/'vsock.sock')});self._api('PUT','/actions',{'action_type':'InstanceStart'})
        self.wait_fence(0);self.record('boot','complete',self.evidence())
    def _seal_allocation(self):
        # Kept inside this already sealed module: no expansion of runner imports.
        def identity(st):return {'device':st.st_dev,'inode':st.st_ino}
        assets={}
        for name,mode in (('fc',0o500),('Image',0o400),('initrd.gz',0o400)):
            fd=os.open(self.root/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
            with os.fdopen(fd,'rb') as stream:
                st=os.fstat(stream.fileno())
                require(stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==mode and 0<st.st_size<=128<<20,'seal asset custody')
                digest=hashlib.sha256()
                for block in iter(lambda:stream.read(1<<20),b''):digest.update(block)
                end=os.fstat(stream.fileno());named=(self.root/name).lstat()
                require(all(getattr(st,k)==getattr(end,k)==getattr(named,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode','st_uid','st_nlink')),'seal asset changed')
            assets[name]=dict(identity(st),bytes=st.st_size,sha256=digest.hexdigest())
        cg=Path(self.config['external_cgroup'])
        require(cg==cg.resolve(strict=True) and 'newton-ia.slice' in cg.parts,'seal cgroup custody')
        owner_start=checks.pid_identity(os.getpid());require(type(owner_start)is int and owner_start>0,'seal owner identity')
        seal={'schema':'rewind-recovery-seal/v1','config_sha256':hashlib.sha256(json.dumps(self.config,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
              'base':identity(self.root.parent.lstat()),'root':identity(self.root.lstat()),
              'external_cgroup':str(cg),'cgroup':identity(cg.lstat()),'assets':assets,
              'owner':{'pid':os.getpid(),'start_ticks':owner_start}}
        raw=json.dumps(seal,sort_keys=True,separators=(',',':')).encode()
        fd=os.open(self.root/'recovery.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        dfd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:os.fsync(dfd)
        finally:os.close(dfd)
        return hashlib.sha256(raw).hexdigest()
    def _spawn(self):
        with self.close_lock:return self._spawn_locked()
    def _spawn_locked(self):
        require(not self.abort.is_set(),'runtime stopping')
        require(self.process is None or self.process.poll() is not None,'old native still live')
        scope(self.config['external_cgroup']);self.record('spawn','intent')
        self.process=subprocess.Popen([str(self.root/'fc'),'--api-sock',str(self.root/'api.sock')],cwd=self.root,
            env={'PATH':'/usr/bin:/bin','LANG':'C'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,close_fds=True,start_new_session=True)
        self.start=None;self.pidfd=None;self.thread=None;self.fences=0;self.counter=None;self.close_forced=None
        self.record('spawn','returned',self.evidence())
        self.pidfd=os.pidfd_open(self.process.pid);self.start=checks.pid_identity(self.process.pid)
        self.thread=threading.Thread(target=self._drain,daemon=True);self.thread.start();self.live()
        checks.wait_socket(self.root/'api.sock',self.process,time.monotonic()+self.config['startup_seconds'])
        self.record('spawn','bound',self.evidence())
    def wait_fence(self,old):
        end=time.monotonic()+self.config['startup_seconds']
        while self.fences<=old:
            self.live();require(time.monotonic()<end,'quiescent fence missing');time.sleep(.02)
    def quiesce(self):
        if self.stream is not None:
            old=self.fences;self.stream.close();self.stream=None;self.wait_fence(old)
        else:require(self.fences>0,'no quiescent witness')
    def pause(self):
        self.record('pause','intent');self.quiesce();self._api('PATCH','/vm',{'state':'Paused'});self.paused=True;self.record('pause','complete')
    def snapshot(self,point_id):
        with self.close_lock:
            require(not self.abort.is_set(),'runtime stopping')
            return self._snapshot(point_id)
    def _snapshot(self,point_id):
        require(self.paused and self.stream is None and point_id not in self.points and point_id not in self.staged and point_id not in self.retired,'point admission')
        victim=None
        if len(self.points)>=2:
            candidates=[p for key,p in self.points.items() if key!=self.mapped]
            require(candidates,'all points mapped')
            victim=min(candidates,key=lambda p:(p['created_order'],p['point_id']))
        require(shutil.disk_usage(self.root).free>=300<<20,'snapshot headroom')
        allocated=0
        for key in set(self.points)|self.staged|self.retired:
            for suffix in ('.state','.mem'):
                path=self.root/(key+suffix)
                if path.exists():allocated+=pin(path)['bytes']
        require(allocated+(300<<20)<=1<<30,'staged ring byte admission')
        self.record('mark','intent',{'point_id':point_id,'victim':victim['point_id'] if victim else None})
        state=self.root/(point_id+'.state');memory=self.root/(point_id+'.mem')
        require(not state.exists() and not memory.exists(),'point path reused');self.staged.add(point_id)
        self._api('PUT','/snapshot/create',{'snapshot_type':'Full','snapshot_path':str(state),'mem_file_path':str(memory)})
        state_pin=pin(state);memory_pin=pin(memory);created=time.monotonic_ns();require(0<created<=2**53-1,'host monotonic clock unavailable')
        point={'point_id':point_id,'created_order':self.point_order+1,'created_mono_ns':created,'compatibility_hash':self.compatibility,'counter':self.counter,'state':state_pin,'memory':memory_pin}
        require(allocated+point['state']['bytes']+point['memory']['bytes']<=1<<30,'ring byte ceiling')
        if victim:self.verify_point(victim['point_id']);require(victim['point_id']!=self.mapped,'victim became mapped')
        self.record('mark','published',{'point':point,'victim':victim['point_id'] if victim else None})
        previous=dict(self.points);previous_order=self.point_order
        updated=dict(self.points);updated[point_id]=point
        if victim:updated.pop(victim['point_id']);self.retired.add(victim['point_id'])
        self.points=updated;self.point_order=point['created_order'];self.staged.remove(point_id)
        self.pending_publication[point_id]=(previous,previous_order,victim)
        return point
    def finalize_mark(self,point_id):
        with self.close_lock:
            previous,order,victim=self.pending_publication.pop(point_id)
            if victim:
                try:
                    for suffix in ('.state','.mem'):(self.root/(victim['point_id']+suffix)).unlink()
                    self.retired.remove(victim['point_id'])
                except OSError:pass  # retired files stay accounted until owned Stop.
    def rollback_mark(self,point_id):
        with self.close_lock:
            if self.abort.is_set():return
            pending=self.pending_publication.pop(point_id,None)
            if pending is not None:
                previous,order,victim=pending;self.points=previous;self.point_order=order;self.staged.add(point_id)
                if victim:self.retired.discard(victim['point_id'])
    def verify_point(self,point_id):
        require(point_id in self.points,'unknown point');point=self.points[point_id]
        require(point['compatibility_hash']==self.compatibility,'point compatibility changed')
        require(pin(self.root/(point_id+'.state'))==point['state'] and pin(self.root/(point_id+'.mem'))==point['memory'],'point changed');return point
    def resume_native(self):
        require(self.paused,'native not paused');self.record('resume','intent');self._api('PATCH','/vm',{'state':'Resumed'});self.paused=False
    def restore(self,point_id):
        self.verify_point(point_id);require(self.stream is None,'accepted stream retained')
        self.record('restore','intent',{'point_id':point_id});self.close_process();self._spawn();self.mapped=point_id
        self._api('PUT','/snapshot/load',{'snapshot_path':str(self.root/(point_id+'.state')),
            'mem_backend':{'backend_type':'File','backend_path':str(self.root/(point_id+'.mem'))},'resume_vm':False,
            'vsock_override':{'uds_path':str(self.root/'vsock.sock')}});self._api('PATCH','/vm',{'state':'Resumed'});self.paused=False
    def reset(self,binding):
        require(not self.abort.is_set() and not self.paused,'runtime not accepting');require(self.stream is None,'one stream owner');self.record('reset','intent',{'generation':binding['generation'],'authority_epoch':binding['authority_epoch']})
        request={'schema':'rewind_guest_reset/v0.2','op':'reseed','boot_token':self.boot_token,'session_id':binding['session_id'],
            'authority_epoch':binding['authority_epoch'],'command_generation':binding['generation'],'workload_id':binding['workload_id'],
            'owner_id':binding['owner_id'],'reservation_id':binding['reservation_id'],'challenge':secrets.token_hex(32),'entropy':secrets.token_hex(64)}
        sock=checks.connect_guest(self.root/'vsock.sock',self.process,time.monotonic()+self.config['startup_seconds'])
        try:
            end=time.monotonic()+3;raw=json.dumps(request,separators=(',',':')).encode();require(len(raw)<=4096,'reset bound')
            sock.settimeout(checks.remaining(end));sock.sendall(b'RWR1'+struct.pack('>I',len(raw))+raw)
            def read(size):
                out=bytearray()
                while len(out)<size:
                    sock.settimeout(checks.remaining(end));part=sock.recv(size-len(out));require(part,'reset EOF');out.extend(part)
                return bytes(out)
            header=read(8);require(header[:4]==b'RWR1','reset magic');size=struct.unpack('>I',header[4:])[0];require(0<size<=4096,'reset size')
            reply=strict_object(read(size));require(set(reply)=={'schema','op','session_id','authority_epoch','command_generation','challenge','guest_nonce','counter','commands_fenced'},'reset shape')
            require(reply['schema']=='rewind_guest_reset/v0.2' and reply['op']=='reseeded' and reply['commands_fenced'] is True,'reset response')
            for key in ('session_id','authority_epoch','command_generation','challenge'):require(type(reply[key])is type(request[key]) and reply[key]==request[key],'reset correlation')
            import re
            require(type(reply['guest_nonce'])is str and re.fullmatch('[0-9a-f]{64}',reply['guest_nonce']) and reply['guest_nonce'] not in self.nonces,'fresh nonce required')
            require(type(reply['counter'])is int and 0<=reply['counter']<=2**53-1,'counter measurement');self.nonces.add(reply['guest_nonce'])
            sock.setblocking(False);wire=FramedSocket(sock,Contracts().wire);deadline=time.monotonic()+self.config['startup_seconds']
            wire.send(1,{'kind':'hello','workload_id':binding['workload_id'],'generation':binding['generation'],'reservation_id':binding['reservation_id'],
                'owner_id':binding['owner_id'],'profile_id':'guest-command-arm64-v1','nonce':reply['guest_nonce']},deadline=deadline)
            kind,meta,data=wire.receive(lifetime_deadline=deadline)
            require(kind==5 and meta['kind']=='ready' and not data and all(meta[k]==binding[k] for k in ('workload_id','generation','reservation_id')),'ready correlation')
            self.stream=wire;self.record('reset','complete',{'counter':reply['counter']});return reply['counter']
        except BaseException:sock.close();raise
    def close_process(self):
        with self.close_lock:return self._close_process()
    def _close_process(self):
        if self.stream is not None:self.stream.close();self.stream=None
        if self.process is not None:
            if self.close_forced is None:self.close_forced=checks.cleanup_process(self.process,self.pidfd,self.config['stop_seconds'])
            if self.thread is not None:self.thread.join(timeout=self.config['stop_seconds']);require(not self.thread.is_alive(),'console ownership unknown')
            elif self.process.stdout is not None:self.process.stdout.close()
            if self.pidfd is not None:os.close(self.pidfd);self.pidfd=None
            require(self.process.poll() is not None,'native closure unproved');self.mapped=None
        if self.root:
            for name in ('api.sock','vsock.sock'):
                path=self.root/name
                if path.exists() or path.is_symlink():require(path.is_socket(),'unexpected socket object');path.unlink()
        return self.evidence()
    def stop(self):
        self.abort.set()
        with self.close_lock:return self._stop()
    def _stop(self):
        if self.closed:return self.evidence()
        # Cleanup remains available even if the journal is poisoned; it cannot assert release then.
        if not self.poisoned and self.ledger is not None:
            try:self.record('stop','intent')
            except BaseException:self.poisoned=True
        self.close_process()
        if self.poisoned:raise RuntimeError('closed process but journal ownership unresolved')
        if self.ledger is not None:self.record('stop','complete',self.evidence())
        if self.root:
            st=self.root.stat();require((st.st_dev,st.st_ino)==self.directory_identity,'runtime directory replaced')
            expected={'fc','Image','initrd.gz','owner.lock','ledger.jsonl','recovery.json'}|{p+s for p in set(self.points)|self.staged|self.retired for s in ('.state','.mem')}
            require({p.name for p in self.root.iterdir()}<=expected,'untracked runtime files retained')
            with self.record_lock:
                if self.ledger is not None:os.close(self.ledger);self.ledger=None
                if self.owner is not None:os.close(self.owner);self.owner=None
            shutil.rmtree(self.root);self.points.clear()
        if self.base_owner is not None:os.close(self.base_owner);self.base_owner=None
        self.closed=True;return self.evidence()
