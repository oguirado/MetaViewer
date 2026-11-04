"""Serialized backend owner. Authentication and host epoch assignment belong to core.

This is not a registered public wire family. No UI or Go activation occurs here.
"""
import copy
import re
import threading
import time
from guest_command_runtime.protocol import prepare_exec
from guest_command_runtime.schema import Contracts
from guest_command_runtime.wire import scalar_safe
from .native import Native, require


def binding(value,owner):
    keys={'owner_id','workload_id','reservation_id','generation','authority_epoch','session_id'}
    require(type(value)is dict and set(value)==keys,'closed binding')
    for key,prefix in [('owner_id','actor-'),('workload_id','workload-'),('reservation_id','reservation-')]:
        require(type(value[key])is str and re.fullmatch(prefix+'[a-z0-9][a-z0-9._-]{0,63}',value[key]),'binding identity')
    require(value['owner_id']==owner,'foreign owner')
    require(type(value['session_id'])is str and re.fullmatch('[A-Za-z0-9][A-Za-z0-9._:-]{0,127}',value['session_id']),'session identity')
    for key in ('generation','authority_epoch'):require(type(value[key])is int and 1<=value[key]<=2**53-1,'binding integer')
    return copy.deepcopy(value)


class Controller:
    def __init__(self,config,native=None):
        self.native=native if native is not None else Native(config)
        self.owner=config['owner_id'];self.phase='new';self.current=None;self.counter=None
        self.lock=threading.Lock();self.state_lock=threading.Lock();self.stop_requested=threading.Event();self.ids=set();self.jobs=set()
        self.contracts=Contracts();self.last_job=None;self.recoverable=False
    def status(self):
        return {'phase':self.phase,'ownership':'released' if self.phase=='stopped' else 'held',
            'binding':copy.deepcopy(self.current),'counter':self.counter,'last_job':copy.deepcopy(self.last_job),
            'points':copy.deepcopy(self.native.points),'cancel_supported':False}
    def _enter(self):
        require(self.lock.acquire(blocking=False),'actor busy')
        if self.stop_requested.is_set():self.lock.release();raise RuntimeError('owner stopping')
    def _reserve(self,request_id):
        require(type(request_id)is str and re.fullmatch('request-[a-z0-9][a-z0-9._-]{0,63}',request_id),'request identity')
        require(request_id not in self.ids and len(self.ids)<1024,'request replay/capacity')
        self.ids.add(request_id)
    def _phase(self,value):
        with self.state_lock:
            require(not self.stop_requested.is_set(),'owner stopping')
            self.phase=value
    def _failed(self):
        with self.state_lock:
            if self.stop_requested.is_set():return
            self.phase='uncertain'
        if not self.stop_requested.is_set():
            try:self.native.record('owner','uncertain')
            except BaseException:pass
    def create(self,value):
        self._enter()
        try:
            require(self.phase=='new','create cannot replay');admitted=binding(value,self.owner)
            self._phase('initializing');self.current=admitted
            try:
                self.native.allocate();self.counter=self.native.reset(admitted);self._phase('ready')
            except BaseException:self._failed();raise
            return self.status()
        finally:self.lock.release()
    def _next(self,value):
        result=binding(value,self.owner)
        require(result['workload_id']==self.current['workload_id'],'foreign workload')
        require(result['authority_epoch']>self.current['authority_epoch'] and result['generation']>self.current['generation'],'stale host authority')
        require(result['session_id']!=self.current['session_id'] and result['reservation_id']!=self.current['reservation_id'],'reused session')
        return result
    def request(self,request,*,next_binding=None,point_id=None,defer_publication=False):
        self._enter()
        try:
            scalar_safe(request)
            require(type(request)is dict and set(request)=={'schema','request_id','op','params'} and request['schema']=='rewind_request/v0.2','request shape')
            op=request['op'];require(op in ('pause','mark','resume','restore'),'unsupported rewind operation')
            params=request['params'];keys={'workload_id','generation','authority_epoch'}|({'label'} if op=='mark' else {'point_id'} if op=='restore' else set())
            require(type(params)is dict and set(params)==keys,'request params')
            require(self.current is not None and all(type(params[k])is type(self.current[k]) and params[k]==self.current[k] for k in ('workload_id','generation','authority_epoch')),'stale request')
            require(self.phase in ('ready','paused') or (op=='restore' and self.phase=='uncertain' and self.recoverable),'owner not operable')
            if op=='pause':require(self.phase=='ready','already paused')
            if op in ('mark','resume'):require(self.phase=='paused','pause required')
            if op=='mark':
                require(type(params['label'])is str and len(params['label'])<=80 and not re.search(r'[\x00-\x1f\x7f/\\]',params['label']),'point label')
                require(type(point_id)is str and re.fullmatch('point-[a-z0-9][a-z0-9._-]{0,63}',point_id),'core point identity')
                require(point_id not in self.native.points,'ring admission')
            following=self._next(next_binding) if op in ('resume','restore') else None
            if op=='restore':self.native.verify_point(params['point_id'])
            self._reserve(request['request_id']);self.native.record(op,'owner_intent',{'request_id':request['request_id'],'next_binding':following})
            if following is not None:self.current=following
            self.recoverable=False
            self._phase({'pause':'pausing','mark':'marking','resume':'resuming','restore':'restoring'}[op])
            try:
                if op=='pause':self.native.pause();self._phase('paused')
                elif op=='mark':
                    self.native.snapshot(point_id);self._phase('paused')
                elif op=='resume':
                    self.native.resume_native();self.counter=self.native.reset(following);self.current=following;self._phase('ready')
                else:
                    self.native.quiesce();self.native.restore(params['point_id']);self.counter=self.native.reset(following);self.current=following;self._phase('ready')
                require(not self.stop_requested.is_set(),'operation interrupted by stop')
                self.native.record(op,'owner_complete',{'request_id':request['request_id']})
                if op=='mark' and not defer_publication:self.native.finalize_mark(point_id)
                return self.status()
            except BaseException:
                if op=='mark':self.native.rollback_mark(point_id)
                if op=='restore' and not self.stop_requested.is_set():
                    try:
                        self.native.close_process()
                        self.recoverable=(self.native.stream is None and (self.native.process is None or self.native.process.poll() is not None) and not self.native.poisoned)
                    except BaseException:self.recoverable=False
                self._failed();raise
        finally:self.lock.release()
    def run(self,request):
        self._enter()
        try:
            require(self.phase=='ready','command not admitted')
            wire_binding={k:self.current[k] for k in ('workload_id','generation','reservation_id')}
            meta,payload=prepare_exec(request,wire_binding,self.contracts)
            require(meta['job_id'] not in self.jobs and len(self.jobs)<1024,'job replay/capacity')
            self._reserve(request['request_id']);self.jobs.add(meta['job_id'])
            self.native.record('run','intent',{'request_id':request['request_id'],'job_id':meta['job_id']});self._phase('running')
            try:
                end=time.monotonic()+meta['timeout_ms']/1000+5
                wire=self.native.stream;require(wire is not None,'guest stream missing')
                wire.send(2,meta,payload,deadline=end)
                output={'stdout':bytearray(),'stderr':bytearray()};chunks={'stdout':0,'stderr':0};accepted=False
                while True:
                    require(not self.stop_requested.is_set(),'command interrupted by stop')
                    kind,event,data=wire.receive(lifetime_deadline=end)
                    require(kind==5 and all(event[k]==v for k,v in wire_binding.items()) and event.get('request_id')==meta['request_id'],'command correlation')
                    if event['kind']=='accepted':
                        require(not accepted and event['op']=='exec' and not data,'command acceptance');accepted=True
                    elif event['kind']=='output':
                        stream=event['stream'];require(accepted and event['job_id']==meta['job_id'] and event['chunk_index']==chunks[stream],'output sequence')
                        chunks[stream]+=1;output[stream].extend(data);require(sum(map(len,output.values()))<=65536,'output bound')
                    elif event['kind']=='job_finished':
                        require(accepted and not data and event['job_id']==meta['job_id'] and event['job_empty'] is True,'job closure')
                        require(event['stdout_sent_bytes']==len(output['stdout']) and event['stderr_sent_bytes']==len(output['stderr']),'output byte accounting')
                        require(not self.stop_requested.is_set(),'command interrupted by stop')
                        self.last_job={'request_id':meta['request_id'],'job_id':meta['job_id'],'terminal':copy.deepcopy(event),
                            'stdout':bytes(output['stdout']),'stderr':bytes(output['stderr'])}
                        self.native.record('run','complete',{'request_id':meta['request_id'],'job_id':meta['job_id'],'stdout_bytes':len(output['stdout']),'stderr_bytes':len(output['stderr'])})
                        self._phase('ready');return copy.deepcopy(self.last_job)
                    else:raise RuntimeError('unexpected job event')
            except BaseException:self._failed();raise
        finally:self.lock.release()
    def cancel(self,*args,**kwargs):raise NotImplementedError('asynchronous cancel is not available in this source slice')
    def stop(self):
        # The runner may invoke this independent close while a bounded receive is in progress.
        with self.state_lock:self.stop_requested.set();self.phase='stopping'
        try:
            proof=self.native.stop();require(proof['closed'] is True,'physical close missing')
            with self.state_lock:self.phase='stopped'
            return self.status()
        except BaseException:
            with self.state_lock:self.phase='uncertain'
            raise
