"""REWIND operations on the existing guest-command IO owner; no native actions."""
from __future__ import annotations
import copy
import hashlib
import queue
import secrets
import threading
import time
from .guest_command import GuestOperation, GuestCommandError, GuestCommandUnknown, _timeout

class RewindError(GuestCommandError):
    pass

class _TypedBody:
    schema = ''
    def __init__(self, body):
        from .envelope import _BODIES, _check, _check_json_values, _Mismatch
        try:
            _check_json_values(body)
            _check(body, _BODIES[self.schema], 0)
        except (_Mismatch, KeyError, RecursionError):raise RewindError('invalid typed rewind body') from None
        self._value=copy.deepcopy(body)
    @classmethod
    def parse(cls, body):return cls(body)
    @property
    def value(self):return copy.deepcopy(self._value)

class RewindRequest(_TypedBody):
    schema='rewind_request/v0.2'

class RewindEvent(_TypedBody):
    schema='rewind_event/v0.2'


class RewindSession:
    """Use agent.rewind; the entered ToolClient remains the sole connection.

    status is None until an owned correlated core snapshot exists. target exposes
    the initial GC target/epoch1 without inventing point or compatibility data.
    """
    def __init__(self, guest):
        self.guest=guest
        self._session=None
        self._target=None
        self._ops={}
        self._pending=None
        self._seen=set()
        self._recovered=set()
        self._uncertain=False
        self._external_stopping=False

    @property
    def status(self):
        with self.guest._lock:return copy.deepcopy(self._session) if self.guest._bootstrap_complete else None

    @property
    def target(self):
        with self.guest._lock:
            return self._target_snapshot() if self.guest._bootstrap_complete else None

    def _target_snapshot(self):
        with self.guest._lock:
            if self._target is not None:return copy.deepcopy(self._target)
            s=self.guest._session
            if s is None or s['ownership']!='held' or s['phase']!='ready':return None
            return dict(workload_id=s['workload_id'],generation=s['generation'],authority_epoch=1)

    def wait_ready(self,timeout=None):
        if not self.guest._ready_notice.wait(timeout):return False
        with self.guest._lock:return self.guest._session is not None and self.guest._session['ownership']=='held' and self.guest._session['phase']=='ready' and not self.guest._uncertain and self.command_allowed()

    def command_allowed(self):
        return self.guest._bootstrap_complete and not self._uncertain and self._pending is None and (self._session is None or self._session['phase']=='ready')

    def _point_id(self,rid,workload):
        h=hashlib.sha256()
        for part in (self.guest.client.session_id,workload,rid):
            raw=part.encode('utf-8');h.update(len(raw).to_bytes(8,'big'));h.update(raw)
        return 'point-'+h.hexdigest()

    def start(self,op,*,label=None,point_id=None,timeout_ms=30000):
        _timeout(timeout_ms)
        with self.guest._lock:
            if not self.guest._bootstrap_complete:raise RewindError('guest bootstrap is not complete')
            target=self.target
            if target is None or self.guest._closed or self.guest._halt.is_set() or self._pending is not None or self._uncertain:
                raise RewindError('no ready owned rewind target')
            if self.guest._run is not None and not self.guest._run.done():raise RewindError('active guest command')
            if any(not item.done() for item in self.guest._ops.values()):raise RewindError('guest control pending')
            phase=self._session['phase'] if self._session else 'ready'
            if op=='pause' and phase!='ready' or op=='resume' and phase!='paused' or op=='mark' and phase not in ('ready','paused') or op=='restore' and phase not in ('paused','recoverable'):
                raise RewindError('operation not admitted in current phase')
            params=copy.deepcopy(target)
            if op=='mark':params['label']=label
            elif op=='restore':
                params['point_id']=point_id
                if phase=='recoverable' and point_id!=self._session['last_good_usable']:raise RewindError('recovery requires last good point')
            elif op not in ('pause','resume'):raise RewindError('unsupported rewind operation')
            body=dict(schema='rewind_request/v0.2',request_id='request-'+secrets.token_hex(16),op=op,params=params)
            RewindRequest.parse(body)
            self.guest.client._envelope(body,body['request_id'])
            if len(self._ops)>=256:raise RewindError('rewind request history exhausted')
            item=GuestOperation(body,time.monotonic()+timeout_ms/1000);item._pump_thread=self.guest._thread
            item.origin=phase;item.planned=copy.deepcopy(target);item.passive=False
            if op in ('resume','restore') or op=='mark' and phase=='ready':
                for key in ('generation','authority_epoch'):
                    item.planned[key]+=1
                    if item.planned[key]>9007199254740991:raise RewindError('counter exhausted')
            self._ops[item.request_id]=item;self._pending=item;self._target=copy.deepcopy(item.planned)
            try:self.guest._queue.put_nowait(item)
            except queue.Full:
                del self._ops[item.request_id];self._pending=None;self._target=target
                raise RewindError('operation queue full') from None
            self.guest._wake.set();return item

    def _sync(self,op,**kwargs):
        if threading.current_thread() is self.guest._thread:raise RewindError('IO owner cannot queue a synchronous wait')
        return self.start(op,**kwargs).result()
    def pause(self,*,timeout_ms=30000):return self._sync('pause',timeout_ms=timeout_ms)
    def resume(self,*,timeout_ms=30000):return self._sync('resume',timeout_ms=timeout_ms)
    def mark(self,label,*,timeout_ms=30000):return self._sync('mark',label=label,timeout_ms=timeout_ms)
    def restore(self,point_id,*,timeout_ms=30000):return self._sync('restore',point_id=point_id,timeout_ms=timeout_ms)

    def _stop_pending(self):return self._external_stopping or any(o.op=='stop' and not o.done() for o in self.guest._ops.values())
    def _failed(self,reason):
        self._uncertain=True
        if self._session is not None and self._session['ownership']=='held':self._session['phase']='uncertain'
        for item in self._ops.values():
            if not item.done():
                item.unknown=True;item.deadline=None;item._future.set_exception(GuestCommandUnknown(reason))
    def _poll(self,now):
        if any(not o.done() and o.deadline is not None and now>=o.deadline for o in self._ops.values()):self._failed('rewind deadline; no replay')
    def _closed(self):
        for item in self._ops.values():
            if not item.done():
                item.unknown=True;item.deadline=None;item._future.set_exception(GuestCommandUnknown('guest closed before rewind completion'))
        if self._session is not None:
            self._session.update(phase='stopped',ownership='released',pending_request_id=None)
            for point in self._session['points']:point['active_references']=0
        self._pending=None

    def _passive(self,e):
        if self._pending is not None or len(self._ops)>=256:raise RewindError('overlapping observed rewind')
        if not self.guest._observe_owned or e['event'] not in ('accepted','outcome_unknown'):raise RewindError('unmatched rewind request')
        target=self._target_snapshot();s=e['session']
        if target is None:raise RewindError('no confirmed GC target')
        op=e['data']['op'];origin=self._session['phase'] if self._session else 'ready'
        planned=copy.deepcopy(target)
        if op in ('resume','restore') or op=='mark' and origin=='ready':
            planned['generation']+=1;planned['authority_epoch']+=1
        item=GuestOperation(dict(schema='rewind_request/v0.2',request_id=e['request_id'],op=op,params=target),None)
        item.sent=True;item.passive=True;item.origin=origin;item.planned=planned;item._pump_thread=self.guest._thread
        self._ops[item.request_id]=item;self._pending=item;return item

    @staticmethod
    def _check_points(s):
        ids=[p['point_id'] for p in s['points']]
        if len(set(ids))!=len(ids) or any(p['compatibility_sha256']!=s['compatibility_sha256'] for p in s['points']):raise RewindError('invalid point set')
        if s['last_good_usable'] is not None and not any(p['point_id']==s['last_good_usable'] and p['status']=='usable' for p in s['points']):raise RewindError('invalid last good point')

    def _handle(self,e):
        RewindEvent.parse(e)
        if e['event_id'] in self._seen or len(self._seen)>=1024:raise RewindError('rewind event replay/capacity')
        if e['owner_id']!=self.guest._owner:raise RewindError('foreign rewind owner')
        item=self._ops.get(e['request_id'])
        if item is None:item=self._passive(e)
        if not item.sent or e['data']['op']!=item.op:raise RewindError('rewind correlation')
        if self._pending is not item:raise RewindError('stale rewind operation')
        kind=e['event'];s=e['session'];old_points=self._session['points'] if self._session else []
        old_good=self._session['last_good_usable'] if self._session else None
        if s is not None:
            self._check_points(s)
            base=self.guest._session
            if base is None or s['owner_id']!=self.guest._owner or s['workload_id']!=base['workload_id']:raise RewindError('foreign rewind workload')
            if kind!='refused' and any(s[k]!=item.planned[k] for k in ('workload_id','generation','authority_epoch')):raise RewindError('rewind tuple changed')
        if kind=='refused':
            if item.accepted or item.unknown:raise RewindError('late rewind refusal')
            item.refused=True;item.deadline=None
            if not item.done():item._future.set_exception(RewindError('request refused: '+e['data']['code']))
            self._pending=None
            if s is not None:
                self._session=copy.deepcopy(s);self._target={k:s[k] for k in ('workload_id','generation','authority_epoch')}
                self._uncertain=s['phase']=='uncertain'
            else:self._target=None
        elif kind=='accepted':
            if item.accepted or item.unknown or self._uncertain or s['pending_request_id']!=item.request_id or s['points']!=old_points or s['last_good_usable']!=old_good:raise RewindError('invalid acceptance')
            expected={'pause':'pausing','resume':'resuming','mark':'marking','restore':'restoring'}[item.op]
            if s['phase']=='stopping' and self.guest._observe_owned:self._external_stopping=True
            if s['phase']!=expected and not (s['phase']=='stopping' and self._stop_pending()):raise RewindError('invalid acceptance phase')
            item._accepted.set();self._session=copy.deepcopy(s);self._target=copy.deepcopy(item.planned)
        elif kind=='outcome_unknown':
            if s is not None:
                if s['phase']!='uncertain' or s['pending_request_id']!=item.request_id or s['points']!=old_points or s['last_good_usable']!=old_good:raise RewindError('unknown metadata injection')
                self._session=copy.deepcopy(s)
            self._target=copy.deepcopy(item.planned);self._failed('core rewind outcome unknown')
        elif kind=='recovery_ready':
            if not self._uncertain or not item.unknown or item.op!='restore' or item.request_id in self._recovered or self._target!=item.planned or self._session is None or self._session['phase']!='uncertain' or self._stop_pending() or e['data']['failed_request_id']!=item.request_id or not e['data']['no_active_vmm']:raise RewindError('invalid recovery')
            if s['phase']!='recoverable' or s['pending_request_id'] is not None or s['last_good_usable']!=e['data']['point_id'] or any(p['active_references']!=0 for p in s['points']):raise RewindError('invalid recovery state')
            expected=copy.deepcopy(old_points)
            for p in expected:p['active_references']=0
            if s['points']!=expected or not item.passive and e['data']['point_id']!=item.body['params']['point_id']:raise RewindError('recovery changed immutable ring')
            self._recovered.add(item.request_id)
            self._session=copy.deepcopy(s);self._target=copy.deepcopy(item.planned);self._pending=None;self._uncertain=False
        elif kind=='completed':
            if not item.accepted or item.unknown or item.done() or self._uncertain or s['pending_request_id'] is not None:raise RewindError('invalid completion')
            expected='paused' if item.op=='pause' or item.op=='mark' and item.origin=='paused' else 'ready'
            if s['phase']=='stopping' and self.guest._observe_owned:self._external_stopping=True
            if s['phase']!=expected and not (s['phase']=='stopping' and self._stop_pending()):raise RewindError('invalid completed phase')
            if item.op=='mark':
                wanted=self._point_id(item.request_id,s['workload_id'])
                prior=copy.deepcopy(old_points)
                if len(prior)==2:
                    victims=[p for p in prior if p['active_references']==0]
                    if not victims:raise RewindError('no rotation victim')
                    victim=min(victims,key=lambda p:(p['created_order'],p['point_id']));prior=[p for p in prior if p['point_id']!=victim['point_id']]
                if e['data']['point_id']!=wanted or len(s['points'])!=len(prior)+1 or s['points'][:-1]!=prior or s['points'][-1]['point_id']!=wanted:raise RewindError('foreign point publication')
                point=s['points'][-1]
                if point['source_generation']!=item.body['params']['generation'] or point['source_authority_epoch']!=item.body['params']['authority_epoch']:raise RewindError('foreign point origin')
                if not item.passive and point['label']!=item.body['params']['label']:raise RewindError('foreign point label')
            if item.op=='restore':
                if not item.passive and e['data']['point_id']!=item.body['params']['point_id']:raise RewindError('foreign restore point')
                expected=copy.deepcopy(old_points)
                for p in expected:p['active_references']=int(p['point_id']==e['data']['point_id'])
                if s['points']!=expected or s['last_good_usable']!=e['data']['point_id']:raise RewindError('restore changed immutable ring')
            if item.op in ('pause','resume') and (s['points']!=old_points or s['last_good_usable']!=old_good):raise RewindError('control changed immutable ring')
            self._session=copy.deepcopy(s);self._target=copy.deepcopy(item.planned);self._pending=None
            if s['phase']=='ready' and not self._stop_pending():self.guest._commit_rewind(s)
            item.deadline=None;item._future.set_result(copy.deepcopy(s))
        else:raise RewindError('unsupported rewind event')
        self._seen.add(e['event_id'])
