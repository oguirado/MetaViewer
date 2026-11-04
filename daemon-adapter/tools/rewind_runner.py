"""Sealed private rewind service. Inputs are authenticated by the Go owner."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import stat
import sys
import threading
import types
import uuid

NORMAL=('__init__','_schemas','wire','schema','config','image','native_checks','protocol')
REWIND=('__init__','config','native','controller')


def checked(path,digest):
    path=Path(path)
    if not path.is_absolute() or path.resolve()!=path:raise ValueError('source alias')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    with os.fdopen(fd,'rb') as stream:
        st=os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid not in (0,os.getuid()) or st.st_mode&0o022 or st.st_nlink!=1 or st.st_size>2<<20:raise ValueError('source custody')
        raw=stream.read((2<<20)+1);end=os.fstat(stream.fileno());named=path.lstat()
        if len(raw)>2<<20 or any(getattr(st,k)!=getattr(end,k) or getattr(st,k)!=getattr(named,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns')):raise ValueError('source changed')
    if hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('source hash')
    return raw


def load_modules(root,files):
    expected={'guest_command_runtime/'+n+'.py' for n in NORMAL}|{'rewind_runtime/'+n+'.py' for n in REWIND}
    source={}
    for item in files:
        if set(item)!={'path','relative','sha256'} or item['relative'] not in expected or item['relative'] in source:raise ValueError('closed source set')
        source[item['relative']]=checked(root/'bundle'/item['relative'],item['sha256'])
    if set(source)!=expected:raise ValueError('missing source')
    for package,names in (('guest_command_runtime',NORMAL),('rewind_runtime',REWIND)):
        module=types.ModuleType(package);module.__path__=[];module.__file__=str(root/'bundle'/package/'__init__.py');sys.modules[package]=module
        exec(compile(source[package+'/__init__.py'],module.__file__,'exec'),module.__dict__)
        for name in names[1:]:
            full=package+'.'+name;part=types.ModuleType(full);part.__package__=package;part.__file__=str(root/'bundle'/package/(name+'.py'));sys.modules[full]=part;setattr(module,name,part)
            exec(compile(source[package+'/'+name+'.py'],part.__file__,'exec'),part.__dict__)


class Adapter:
    def __init__(self,controller,session,state_dir,contracts,emit):
        self.backend=controller;self.session=session;self.contracts=contracts;self.emit_callback=emit
        self.gc=None;self.token=None;self.create_id=None;self.stopping=False;self.stop_attempted=False;self.finished=threading.Event();self.finished.set()
        self.events_lock=threading.RLock();self.seq=0;self.head='0'*64;self.seen=set();self.points={}
        self.journal=os.open(Path(state_dir)/'rewind-events.jsonl',os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    def persist(self,item):
        text=json.dumps(item,sort_keys=True,separators=(',',':'));row={'seq':self.seq+1,'prev':self.head,'payload':text}
        row['sha256']=hashlib.sha256((str(row['seq'])+'\n'+self.head+'\n'+text).encode()).hexdigest();raw=(json.dumps(row)+'\n').encode()
        if os.fstat(self.journal).st_size+len(raw)>8<<20:raise ValueError('event journal bound')
        view=memoryview(raw)
        while view:
            count=os.write(self.journal,view)
            if count<=0:raise OSError('journal write')
            view=view[count:]
        os.fsync(self.journal);self.seq=row['seq'];self.head=row['sha256']
    def event(self,family,request,kind,data,session):
        with self.events_lock:
            value={'schema':family,'event_id':'event-'+uuid.uuid4().hex,'request_id':request['request_id'],'owner_id':self.backend.owner,'event':kind,'session':copy.deepcopy(session),'data':data}
            if family=='guest_command_event/v0.2':value['reservation_id']=self.token;self.contracts.validate('guest_command_event.schema.json',value)
            recorded=copy.deepcopy(value)
            if kind=='output':
                raw=base64.b64decode(recorded['data'].pop('data_b64'));recorded['data'].update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
            self.persist({'event':recorded});self.emit_callback(value)
    def rw_session(self,binding,phase,pending):
        return {'schema':'rewind_session/v0.2','workload_id':binding['workload_id'],'generation':binding['generation'],'authority_epoch':binding['authority_epoch'],
            'owner_id':binding['owner_id'],'authority':'core','compatibility_sha256':self.backend.native.compatibility,'profile_id':'rewind-arm64-v1','backend':'firecracker','isa':'aarch64',
            'disk_scope':'immutable-boot-and-ram-workspace','external_effects_warning':'External effects are not rewound.','phase':phase,'ownership':'held','pending_request_id':pending,
            'guest_counter':self.backend.counter,'points':[{**p,'active_references':int(self.backend.native.mapped==key)} for key,p in self.points.items()],
            'last_good_usable':next(reversed(self.points)) if self.points else None}
    def submit(self,packet):
        if type(packet)is not dict or set(packet)!={'request','binding','point_id','public_reservation'}:raise ValueError('private packet shape')
        request=packet['request'];rid=request['request_id'];op=request['op'];family=request['schema'];binding=packet['binding']
        from rewind_runtime.controller import binding as validate_binding
        validate_binding(binding,self.backend.owner)
        if rid in self.seen or len(self.seen)>=1024:raise ValueError('private request replay')
        self.seen.add(rid);self.persist({'request_id':rid,'sha256':hashlib.sha256(json.dumps(packet,sort_keys=True).encode()).hexdigest()})
        if family=='guest_command_request/v0.2':
            self.contracts.validate('guest_command_request.schema.json',request)
            if op=='create':
                if self.gc is not None:raise ValueError('duplicate create')
                self.token=packet['public_reservation'];self.create_id=rid
                self.gc={'schema':'guest_command_session/v0.2','workload_id':binding['workload_id'],'generation':binding['generation'],'owner_id':binding['owner_id'],
                    'profile_id':'guest-command-arm64-v1','backend':'firecracker','isa':'aarch64','phase':'starting','ownership':'held','jobs_started':0,'job':None,'controls':{'cancel':None,'stop':None}}
                self.event('guest_command_event/v0.2',request,'accepted',{'op':'create'},self.gc)
                try:self.backend.create(binding);self.gc['phase']='ready';self.event('guest_command_event/v0.2',request,'ready',{},self.gc)
                except BaseException:self.gc['phase']='uncertain';self.event('guest_command_event/v0.2',request,'outcome_unknown',{'op':'create','code':'TRANSPORT'},self.gc)
                return
            if op=='cancel':self.event('guest_command_event/v0.2',request,'refused',{'op':op,'code':'UNAVAILABLE'},self.gc);return
            if op=='run':return self.run_job(request)
            if op=='stop':return self.stop(request)
            raise ValueError('unsupported guest operation')
        if family!='rewind_request/v0.2':raise ValueError('request family')
        phase={'pause':'pausing','resume':'resuming','mark':'marking','restore':'restoring'}[op]
        if self.gc is None:raise ValueError('create required')
        self.gc['generation']=binding['generation']
        self.event('rewind_event/v0.2',request,'accepted',{'op':op},self.rw_session(binding,phase,rid))
        try:
            old=copy.deepcopy(self.backend.current);composite=(op=='mark' and self.backend.phase=='ready')
            if composite:
                pause={'schema':'rewind_request/v0.2','request_id':'request-'+hashlib.sha256((rid+'pause').encode()).hexdigest(),'op':'pause','params':{k:old[k] for k in ('workload_id','generation','authority_epoch')}}
                self.backend.request(pause)
            self.backend.request(request,next_binding=binding if op in ('resume','restore') else None,point_id=packet['point_id'] or None,defer_publication=composite)
            if op=='mark':
                if binding['generation']!=old['generation']:
                    resume={'schema':'rewind_request/v0.2','request_id':'request-'+hashlib.sha256((rid+'resume').encode()).hexdigest(),'op':'resume','params':{k:old[k] for k in ('workload_id','generation','authority_epoch')}}
                    self.backend.request(resume,next_binding=binding)
                if composite:self.backend.native.finalize_mark(packet['point_id'])
                p=self.backend.native.points[packet['point_id']]
                self.points[packet['point_id']]={'schema':'rewind_point/v0.2','point_id':packet['point_id'],'label':request['params']['label'],'created_order':p['created_order'],'created_mono_ns':p['created_mono_ns'],
                    'source_generation':old['generation'],'source_authority_epoch':old['authority_epoch'],'compatibility_sha256':p['compatibility_hash'],
                    'state_sha256':p['state']['sha256'],'memory_sha256':p['memory']['sha256'],'state_bytes':p['state']['bytes'],'memory_bytes':p['memory']['bytes'],
                    'counter_value':p['counter'],'status':'usable','active_references':0}
                self.points={key:value for key,value in self.points.items() if key in self.backend.native.points}
            if self.stopping:return
            state=self.rw_session(binding,self.backend.phase,None)
            if op=='restore':state['last_good_usable']=request['params']['point_id']
            if state['phase']=='ready':
                self.gc.update(phase='ready',job=None,controls={'cancel':None,'stop':None})
            self.event('rewind_event/v0.2',request,'completed',{'op':op,'point_id':packet['point_id'] or None},state)
        except BaseException:
            if op=='mark':self.backend.native.rollback_mark(packet['point_id'])
            if self.stopping:return
            self.event('rewind_event/v0.2',request,'outcome_unknown',{'op':op,'code':'NATIVE'},self.rw_session(binding,'uncertain',rid))
            if op=='restore' and self.backend.recoverable:
                point=request['params']['point_id'];self.backend.native.verify_point(point)
                state=self.rw_session(binding,'recoverable',None);state['last_good_usable']=point
                self.event('rewind_event/v0.2',request,'recovery_ready',{'op':'restore','failed_request_id':rid,'point_id':point,'no_active_vmm':True},state)
    def run_job(self,request):
        rid=request['request_id'];job=request['params']['job_id'];self.finished.clear()
        self.gc.update(phase='running',jobs_started=self.gc['jobs_started']+1,job={'job_id':job,'state':'running','exit_code':None,'signal':None,'stdout_bytes':0,'stderr_bytes':0,'output_complete':False},controls={'cancel':None,'stop':None})
        self.event('guest_command_event/v0.2',request,'accepted',{'op':'run'},self.gc)
        try:
            result=self.backend.run(request);terminal=result['terminal']
            for stream in ('stdout','stderr'):
                raw=result[stream]
                for index,offset in enumerate(range(0,len(raw),16384)):
                    chunk=raw[offset:offset+16384];self.gc['job'][stream+'_bytes']+=len(chunk)
                    self.event('guest_command_event/v0.2',request,'output',{'job_id':job,'stream':stream,'chunk_index':index,'data_b64':base64.b64encode(chunk).decode()},self.gc)
            self.gc['job'].update(state={'exit':'exited','timeout':'timed_out','output_limit':'output_limit'}[terminal['cause']],exit_code=terminal['exit_code'],signal=terminal['signal'],output_complete=terminal['output_complete']);self.gc['phase']='ready'
            self.event('guest_command_event/v0.2',request,'job_finished',{'job_id':job,'cause':terminal['cause'],'stdout_sha256':hashlib.sha256(result['stdout']).hexdigest(),'stderr_sha256':hashlib.sha256(result['stderr']).hexdigest(),
                'guest_job_empty':True,'cancel_request_id':None,'stop_request_id':None,'stdout_sent_bytes':len(result['stdout']),'stderr_sent_bytes':len(result['stderr'])},self.gc)
        except BaseException:
            if not self.stopping:
                self.gc['phase']='uncertain';self.gc['job']['state']='unknown';self.event('guest_command_event/v0.2',request,'outcome_unknown',{'op':'run','code':'TRANSPORT'},self.gc)
        finally:self.finished.set()
    def stop(self,request):
        self.stopping=True;failure=None
        try:
            if self.gc is None:raise ValueError('stop session unavailable')
            self.gc['phase']='stopping';self.gc['controls']['stop']={'request_id':request['request_id'],'ack':'accepted'}
            self.event('guest_command_event/v0.2',request,'accepted',{'op':'stop'},self.gc)
        except BaseException as error:failure=error
        try:
            # Persistence failure must never prevent the owned physical close.
            self.stop_attempted=True;self.backend.stop()
            if not self.finished.wait(5):raise ValueError('actor close unproved')
            if failure is not None:raise failure
            if self.gc['job'] is not None and self.gc['job']['state']=='running':self.gc['job']['state']='unknown'
            self.gc.update(phase='stopped',ownership='released');self.event('guest_command_event/v0.2',request,'stopped',{'native_absent':True},self.gc)
        except BaseException:
            if self.gc is not None:
                self.gc.update(phase='uncertain',ownership='held')
                if self.gc['job'] is not None and self.gc['job']['state']=='running':self.gc['job'].update(state='unknown',output_complete=False)
                try:self.event('guest_command_event/v0.2',request,'outcome_unknown',{'op':'stop','code':'CLEANUP'},self.gc)
                except BaseException:pass
            raise


def dispatch_stop(adapter,packet,done,failure):
    try:adapter.submit(packet)
    except BaseException as error:
        failure.append(type(error).__name__);adapter.stopping=True
        if not adapter.stop_attempted:
            adapter.stop_attempted=True
            try:adapter.backend.stop()
            except BaseException as cleanup:failure.append(type(cleanup).__name__)
        if adapter.gc is not None:adapter.gc.update(phase='uncertain',ownership='held')
    finally:done.set()


def run(attempt):
    root=Path(attempt)
    if root.resolve()!=root or root.stat().st_uid!=os.getuid() or stat.S_IMODE(root.stat().st_mode)!=0o700:raise ValueError('attempt custody')
    spec=json.loads((root/'launch.json').read_bytes())
    if set(spec)!={'files','config','state_dir','runtime_root','unit','session_id'}:raise ValueError('launch shape')
    load_modules(root,spec['files'])
    strict=sys.modules['guest_command_runtime.wire'].strict_object
    config=copy.deepcopy(spec['config']);config['runtime_root']=spec['runtime_root']
    membership=Path('/proc/self/cgroup').read_text().splitlines();groups=[v[3:] for v in membership if v.startswith('0::')]
    if len(groups)!=1 or not groups[0].endswith('/'+spec['unit']):raise ValueError('service ownership')
    config['external_cgroup']='/sys/fs/cgroup'+groups[0]
    controller=sys.modules['rewind_runtime.controller'].Controller(config)
    adapter=Adapter(controller,spec['session_id'],spec['state_dir'],sys.modules['guest_command_runtime.schema'].Contracts(),lambda e:print(json.dumps(e,separators=(',',':')),flush=True))
    pending=queue.Queue(maxsize=4);done=threading.Event();failure=[];stop_started=False
    def reader():
        nonlocal stop_started
        try:
            while True:
                line=sys.stdin.buffer.readline(262145)
                if not line:break
                if len(line)>262144 or not line.endswith(b'\n'):raise ValueError('request bound')
                packet=strict(line)
                if packet['request']['op']=='stop':
                    if stop_started:raise ValueError('duplicate stop dispatch')
                    stop_started=True
                    threading.Thread(target=dispatch_stop,args=(adapter,packet,done,failure),daemon=True,name='rewind-stop').start()
                else:pending.put_nowait(packet)
        except BaseException as error:failure.append(type(error).__name__)
        finally:done.set();controller.stop()
    def finish(*_):done.set();controller.stop()
    signal.signal(signal.SIGTERM,finish);signal.signal(signal.SIGINT,finish)
    print(json.dumps({'guest_command_ready':True,'cgroup':config['external_cgroup']}),flush=True)
    threading.Thread(target=reader,daemon=True,name='rewind-input').start()
    try:
        while not done.is_set():
            try:packet=pending.get(timeout=1)
            except queue.Empty:
                if adapter.gc is not None and controller.phase in ('ready','paused'):
                    try:controller.native.live()
                    except BaseException:
                        adapter.gc['phase']='uncertain';controller._failed()
                        adapter.event('guest_command_event/v0.2',{'request_id':adapter.create_id},'outcome_unknown',{'op':'create','code':'PROCESS_IDENTITY'},adapter.gc)
                continue
            adapter.submit(packet)
            if adapter.stopping:break
    finally:controller.stop();os.close(adapter.journal)
    if failure:raise RuntimeError('private input failure')

if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('one private attempt required')
    run(sys.argv[1])
