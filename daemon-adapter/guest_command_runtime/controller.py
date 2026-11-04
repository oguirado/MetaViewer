"""One state writer and one bounded receiver for an authenticated guest.

The private daemon supplies the fixed actor and envelope session binding.
Neither appears as caller-selected authority in a command request. Native and
wire factories are injection points for tests, not request fields.
"""
import base64
import copy
import hashlib
import queue
import threading
import time
import uuid

from .config import validate
from .native import NativeVM
from .protocol import prepare_exec, reservation_id
from .schema import Contracts, Invalid
from .storage import Store, encode
from .wire import FramedSocket


class Controller:
    def __init__(self, config, session_id, state_root, emit,
                 native_factory=NativeVM, wire_factory=FramedSocket):
        self.config = validate(config)
        self.session_id = session_id
        reservation_id(session_id, 'request-probe')  # Validate binding before allocation.
        self.emit_callback = emit
        self.contracts = Contracts()
        self.store = Store(state_root, hashlib.sha256(encode({'config':config,'session_id':session_id})).hexdigest())
        self.native = native_factory(self.config, self._native_record)
        self.wire_factory = wire_factory
        self.wire = None
        self.queue = queue.Queue(maxsize=32)
        self.state = None
        self.reservation = None
        self.requests = {}
        self.jobs = set()
        self.run_id = self.stop_id = self.create_id = None
        self.unknown = self.broken = self.finished = False
        self.reader = None

    def _native_record(self, kind, proof):
        self.store.append({'kind':'native','stage':kind,'proof':proof})

    def _binding(self):
        return {key:self.state[key] for key in ('workload_id','generation')} | {'reservation_id':self.reservation}

    def _intent(self, request):
        self.store.append({'kind':'intent','request_id':request['request_id'], 'op':request['op'],
                           'request_sha256':hashlib.sha256(encode(request)).hexdigest(),
                           'reservation_id':self.reservation, 'session':self.state})

    def _event(self, request_id, kind, data, *, session=True, reservation=None):
        value={'schema':'guest_command_event/v0.2','event_id':'event-'+uuid.uuid4().hex,
               'request_id':request_id,'reservation_id':reservation or self.reservation,
               'owner_id':self.config['owner_id'], 'session':copy.deepcopy(self.state) if session else None,
               'event':kind,'data':data}
        self.contracts.validate('guest_command_event.schema.json', value)
        journal=copy.deepcopy(value)
        if kind=='output':
            raw=base64.b64decode(journal['data'].pop('data_b64'))
            journal['data'].update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
        self.store.append({'kind':'event','event':journal})
        self.emit_callback(value)
        return value

    def _refuse(self, request, code):
        token = self.reservation or reservation_id(self.session_id, request['request_id'])
        return self._event(request['request_id'],'refused',{'op':request['op'],'code':code},
                           session=False,reservation=token)

    def _send(self, kind, meta, payload=b''):
        self.wire.send(kind,meta,payload,deadline=min(time.monotonic()+3,self.native.lifetime))

    def _unknown(self, request_id, code):
        self.unknown=True
        if self.state is not None:
            self.state['phase']='uncertain'
            self.state['ownership']='held'
            if self.run_id is not None and self.state['job'] is not None:
                self.state['job']['state']='unknown'
        try:
            pending=[rid for rid,item in self.requests.items() if not item['done']]
            if not pending:
                # A held VM can fail while idle. This is a resource-lifetime
                # update tied to the original create, never a rewritten job.
                self._event(self.create_id,'outcome_unknown',{'op':'create','code':code})
            else:
                priority={'run':0,'stop':1,'cancel':2,'create':3}
                rid=min(pending,key=lambda value:priority[self.requests[value]['op']])
                self._event(rid,'outcome_unknown',{'op':self.requests[rid]['op'],'code':code})
                for value in pending:self.requests[value]['done']=True
        finally:
            # Physical containment is attempted even if persistence/output failed.
            self.native.close(graceful=False)

    def request(self, request):
        """Actor-thread method. Parsing/authenticated routing happen before here."""
        self.contracts.validate('guest_command_request.schema.json',request)
        rid,op=request['request_id'],request['op']
        if self.store.recovery_required:
            raise Invalid('surviving state requires native reconciliation')
        if rid in self.requests:
            return self._refuse(request,'DUPLICATE')
        if op=='create':
            if self.state is not None: return self._refuse(request,'BUSY')
            if not self.config['runtime_admitted']: return self._refuse(request,'UNAVAILABLE')
            self.create_id=rid
            self.reservation=reservation_id(self.session_id,rid)
            self.state={'schema':'guest_command_session/v0.2','workload_id':'workload-'+uuid.uuid4().hex,
                        'generation':self.config['generation'],'owner_id':self.config['owner_id'],
                        'profile_id':'guest-command-arm64-v1','backend':'firecracker','isa':'aarch64',
                        'phase':'starting','ownership':'held','jobs_started':0,'job':None,
                        'controls':{'cancel':None,'stop':None}}
            self.requests[rid]={'op':op,'done':False,'accepted':True}
            self._intent(request)
            self._event(rid,'accepted',{'op':op})
            try:
                sock=self.native.open()
                self.wire=self.wire_factory(sock,self.contracts.wire)
                self._send(1,{'kind':'hello',**self._binding(),'owner_id':self.config['owner_id'],
                              'profile_id':'guest-command-arm64-v1','nonce':self.native.nonce})
                kind,meta,payload=self.wire.receive(lifetime_deadline=min(self.native.lifetime,time.monotonic()+self.config['startup_seconds']))
                self._check_binding(kind,meta,payload)
                if meta['kind']!='ready': raise Invalid('ready required')
                self.state['phase']='ready'
                self._event(rid,'ready',{})
                self.requests[rid]['done']=True
                self.reader=threading.Thread(target=self._receive,name='guest-command-reader',daemon=True)
                self.reader.start()
            except BaseException:
                self._unknown(rid,'TRANSPORT')
            return
        if self.state is None:
            return self._refuse(request,'UNAVAILABLE')
        if any(request['params'][key]!=self.state[key] for key in ('workload_id','generation')):
            return self._refuse(request,'STALE')
        if self.state['ownership']!='held': return self._refuse(request,'STALE')
        if op=='run':
            if self.unknown or self.state['phase']!='ready': return self._refuse(request,'BUSY')
            job=request['params']['job_id']
            if job in self.jobs: return self._refuse(request,'DUPLICATE')
            if len(self.jobs)>=64: return self._refuse(request,'CAPACITY')
            try: meta,payload=prepare_exec(request,self._binding(),self.contracts)
            except (ValueError,UnicodeError): return self._refuse(request,'INVALID')
            self.run_id=rid;self.jobs.add(job)
            self.state.update(phase='running',jobs_started=len(self.jobs),
                job={'job_id':job,'state':'running','exit_code':None,'signal':None,
                     'stdout_bytes':0,'stderr_bytes':0,'output_complete':False},
                controls={'cancel':None,'stop':None})
            self.requests[rid]={'op':op,'done':False,'accepted':False}
            self._intent(request)
            self.store.begin_output(job)
            try: self._send(2,meta,payload)
            except BaseException: self._unknown(rid,'TRANSPORT')
        elif op=='cancel':
            if (self.unknown or self.run_id is None or self.state['phase']!='running' or
                    not self.requests[self.run_id]['accepted'] or self.state['controls']['cancel'] is not None or
                    self.state['controls']['stop'] is not None):
                return self._refuse(request,'BUSY')
            if request['params']['job_id']!=self.state['job']['job_id']: return self._refuse(request,'STALE')
            self.state['controls']['cancel']={'request_id':rid,'ack':'pending'}
            self.requests[rid]={'op':op,'done':False,'accepted':False}
            self._intent(request)
            try: self._send(3,{'kind':'cancel',**self._binding(),'request_id':rid,
                               'run_request_id':self.run_id,'job_id':self.state['job']['job_id']})
            except BaseException: self._unknown(rid,'TRANSPORT')
        else:
            if self.stop_id is not None: return self._refuse(request,'BUSY')
            self.stop_id=rid
            self.state['controls']['stop']={'request_id':rid,'ack':'pending'}
            self.requests[rid]={'op':op,'done':False,'accepted':False}
            self._intent(request)
            if self.unknown:
                self._accepted(rid)
                self._closed(False)
            else:
                try:self._send(4,{'kind':'stop',**self._binding(),'request_id':rid})
                except BaseException:self._unknown(rid,'TRANSPORT')

    def _check_binding(self,kind,meta,payload):
        self.contracts.wire(kind,meta,len(payload))
        if kind!=5 or any(meta[key]!=value for key,value in self._binding().items()):
            raise Invalid('guest binding or direction changed')

    def _accepted(self,rid):
        item=self.requests[rid]
        if item['done'] or item['accepted']: raise Invalid('duplicate or late accepted')
        op=item['op'];item['accepted']=True
        if op=='run': self.state['phase']='stopping' if self.state['controls']['stop'] is not None else 'running'
        elif op in ('cancel','stop'):
            control=self.state['controls'][op]
            if control is None or control['request_id']!=rid: raise Invalid('control mismatch')
            control['ack']='accepted'
            self.state['phase']='cancelling' if op=='cancel' and self.state['controls']['stop'] is None else 'stopping'
            if op=='cancel' and self.state['job'] is not None:self.state['job']['state']='cancelling'
        self._event(rid,'accepted',{'op':op})
        if op=='cancel':item['done']=True

    def _phase_after_job(self):
        controls=self.state['controls']
        pending=any(value is not None and value['ack']=='pending' for value in controls.values())
        self.state['phase']='awaiting_control' if pending else ('stopping' if controls['stop'] is not None else 'ready')

    def guest_event(self,kind,meta,payload):
        if self.state is None or self.state['ownership']=='released' or self.unknown:
            return  # Closed/unknown streams cannot manufacture late success.
        self._check_binding(kind,meta,payload)
        event=meta['kind'];rid=meta.get('request_id')
        if event=='accepted':
            public_op='run' if meta['op']=='exec' else meta['op']
            if rid not in self.requests or public_op!=self.requests[rid]['op']:
                raise Invalid('unrequested acceptance')
            expected=None if public_op=='stop' else self.state['job']['job_id']
            if meta['job_id']!=expected: raise Invalid('acceptance job mismatch')
            if meta['op']=='cancel' and self.run_id is None: raise Invalid('late cancel acceptance')
            self._accepted(rid)
        elif event=='output':
            if rid!=self.run_id or not self.requests[rid]['accepted'] or meta['job_id']!=self.state['job']['job_id']:
                raise Invalid('output correlation')
            self.store.retain(meta['job_id'],meta['stream'],meta['chunk_index'],payload)
            summary=self.store.output_summary(meta['job_id'])
            for stream in ('stdout','stderr'):self.state['job'][stream+'_bytes']=summary[stream]['bytes']
            self._event(rid,'output',{'job_id':meta['job_id'],'stream':meta['stream'],
                        'chunk_index':meta['chunk_index'],'data_b64':base64.b64encode(payload).decode('ascii')})
        elif event=='job_finished':
            if rid!=self.run_id or not self.requests[rid]['accepted'] or meta['job_id']!=self.state['job']['job_id']:
                raise Invalid('job terminal correlation')
            job=self.state['job'];controls=self.state['controls']
            for op in ('cancel','stop'):
                control=controls[op]
                expected=control['request_id'] if control is not None and control['ack']=='accepted' else None
                if meta[op+'_request_id']!=expected:raise Invalid('unobserved control in terminal')
            if meta['cause'] in ('cancel','stop') and meta[meta['cause']+'_request_id'] is None:
                raise Invalid('unaccepted terminal cause')
            if ((meta['exit_code'] is None)==(meta['signal'] is None) or
                    not meta['job_empty'] or meta['output_complete'] != (meta['cause']!='output_limit')):
                raise Invalid('invalid process/output proof')
            summary=self.store.output_summary(job['job_id'])
            if any(meta[stream+'_sent_bytes']!=summary[stream]['bytes'] for stream in ('stdout','stderr')):
                raise Invalid('lost output bytes')
            job.update(state={'exit':'exited','cancel':'cancelled','stop':'cancelled','timeout':'timed_out','output_limit':'output_limit'}[meta['cause']],
                       exit_code=meta['exit_code'],signal=meta['signal'],output_complete=meta['output_complete'])
            self.run_id=None;self.requests[rid]['done']=True;self._phase_after_job()
            self._event(rid,'job_finished',{'job_id':meta['job_id'],'cause':meta['cause'],
                        'stdout_sha256':summary['stdout']['sha256'],'stderr_sha256':summary['stderr']['sha256'],
                        'guest_job_empty':True,'cancel_request_id':meta['cancel_request_id'],
                        'stop_request_id':meta['stop_request_id'],'stdout_sent_bytes':summary['stdout']['bytes'],
                        'stderr_sent_bytes':summary['stderr']['bytes']})
        elif event=='stopping':
            if rid!=self.stop_id or not self.requests[rid]['accepted'] or self.run_id is not None:
                raise Invalid('premature stopping')
            if any(control is not None and control['ack']=='pending' for control in self.state['controls'].values()):
                raise Invalid('pending control at stopping')
            self._closed(True)
        elif event=='error':
            control=self.state['controls']['cancel']
            if (control is not None and rid==control['request_id'] and control['ack']=='pending'
                    and meta['code'] in ('BUSY','INVALID')):
                control['ack']='refused';self.requests[rid]['done']=True
                if self.run_id is None:self._phase_after_job()
                self._event(rid,'refused',{'op':'cancel','code':meta['code']})
            else: raise Invalid('guest rejected dispatched operation')
        else: raise Invalid('unexpected guest event')

    def _closed(self,graceful):
        proof=self.native.close(graceful=graceful)
        if proof.get('closed') is not True:raise Invalid('native absence unproved')
        self.state.update(phase='stopped',ownership='released')
        self._event(self.stop_id,'stopped',{'native_absent':True})
        self.requests[self.stop_id]['done']=True

    def _receive(self):
        try:
            while self.state is not None and self.state['ownership']=='held' and not self.unknown:
                event=self.wire.receive(lifetime_deadline=self.native.lifetime)
                self.queue.put(('guest',event),timeout=max(.001,self.native.lifetime-time.monotonic()))
        except BaseException:
            try:self.queue.put(('transport',None),timeout=1)
            except queue.Full:pass

    def submit(self,request):
        self.queue.put(('request',copy.deepcopy(request)),timeout=1)

    def run(self):
        try:
            while not self.finished:
                try:kind,value=self.queue.get(timeout=.1)
                except queue.Empty:
                    if self.state is not None and self.state['ownership']=='held' and not self.unknown and self.native.lifetime is not None and time.monotonic()>=self.native.lifetime:
                        self._unknown(self.stop_id or self.run_id or self.create_id,'DEADLINE')
                    continue
                if kind=='finish':break
                try:
                    if kind=='request':self.request(value)
                    elif kind=='guest':self.guest_event(*value)
                    elif self.state is not None and self.state['ownership']=='held' and not self.unknown:
                        self._unknown(self.stop_id or self.run_id or self.create_id,'TRANSPORT')
                except BaseException:
                    if self.state is not None:
                        self._unknown(self.stop_id or self.run_id or self.create_id,'PROTOCOL')
                    else:raise
        finally:
            self.finished=True
            try:self.native.close(graceful=False)
            finally:
                if self.reader is not None:self.reader.join(timeout=4)
                self.store.close()

    def finish(self):
        self.queue.put(('finish',None),timeout=1)
