"""Strict perception boundary; descriptions are evidence, never verdicts.

[TARGET, unit decision] A supervised transport returns (exit_code, stdout).
This module never guesses executable paths or launches unmanaged children.
"""
import copy
import json
import math
from pathlib import Path
import re


class VisionBridgeError(ValueError):
    pass


def _integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 9007199254740991:
        raise VisionBridgeError('invalid integer')
    return value


def _closed(row, required, optional=()):
    if not isinstance(row, dict) or not set(required) <= row.keys() <= set(required) | set(optional):
        raise VisionBridgeError('invalid keys')


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise VisionBridgeError('duplicate key')
        result[key] = value
    return result


def _ram_path(value):
    if not isinstance(value, str) or '\x00' in value or not Path(value).is_absolute():
        raise VisionBridgeError('invalid RAM path')
    if not Path(value).resolve().is_relative_to('/dev/shm/vqa-cu'):
        raise VisionBridgeError('path outside RAM workspace')


def _box(row, width, height):
    x, y = _integer(row['x']), _integer(row['y'])
    w, h = _integer(row['w'], 1), _integer(row['h'], 1)
    if x + w > width or y + h > height:
        raise VisionBridgeError('rectangle outside frame')
    return dict(x=x, y=y, w=w, h=h)


def _score(value):
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise VisionBridgeError('invalid score')
    return round(value * 1000000)


def parse_description(stdout):
    try:
        if not isinstance(stdout, str) or len(stdout.encode('utf-8')) > 1048576:
            raise VisionBridgeError('description exceeds byte cap')
        row = json.loads(stdout, object_pairs_hook=_pairs)
        _closed(row, ('schema','frame_sha256','width','height','changed','changed_regions','crops','timing_us'),
                ('marks','marks_png','crop_dir','crop_pngs'))
        if row['schema'] != 've.cu_describe/v1' or not isinstance(row['frame_sha256'],str) or not re.fullmatch('[0-9a-f]{64}',row['frame_sha256']):
            raise VisionBridgeError('invalid schema or digest')
        width, height = _integer(row['width'],1), _integer(row['height'],1)
        _integer(row['timing_us'])
        if row['changed'] is not None and type(row['changed']) is not bool:
            raise VisionBridgeError('invalid changed flag')
        result = copy.deepcopy(row)
        for key, cap in (('changed_regions',16),('crops',8),('marks',24)):
            if key not in row: continue
            entries = row[key]
            if not isinstance(entries,list) or len(entries) > cap:
                raise VisionBridgeError('description cap exceeded')
            converted = []
            previous = math.inf
            for index, item in enumerate(entries,1):
                required = ('x','y','w','h','score') if key=='changed_regions' else (
                    ('x','y','w','h','reason') if key=='crops' else ('id','x','y','w','h','kind','score'))
                _closed(item, required, ('ocr_text', 'ocr_score_promille', 'visual_kind', 'missing_reason') if key == 'marks' else ())
                clean = _box(item,width,height)
                if 'score' in item:
                    score = _score(item['score'])
                    if item['score'] > previous: raise VisionBridgeError('scores not descending')
                    previous = item['score']
                    clean['score_ppm'] = score
                if key=='crops':
                    if item['reason'] not in ('changed','salient'): raise VisionBridgeError('invalid crop reason')
                    clean['reason']=item['reason']
                if key=='marks':
                    if type(item['id']) is not int or item['id'] != index or item['kind'] not in ('button','tab','field','row','icon','text','unknown'):
                        raise VisionBridgeError('invalid mark')
                    clean.update(id=index,kind=item['kind'])
                    ocr_keys = {'ocr_text', 'ocr_score_promille', 'visual_kind', 'missing_reason'}
                    if ocr_keys & item.keys():
                        if not ocr_keys <= item.keys(): raise VisionBridgeError('incomplete OCR fields')
                        text, confidence, reason = item['ocr_text'], item['ocr_score_promille'], item['missing_reason']
                        if item['visual_kind'] not in ('textline','pill','icon_btn','canvas_ctrl'):
                            raise VisionBridgeError('invalid visual kind')
                        for value in (text, reason):
                            if value is not None and (not isinstance(value,str) or not value or len(value.encode('utf-8')) > 64):
                                raise VisionBridgeError('invalid OCR string')
                        if text is None:
                            if confidence is not None or reason is None: raise VisionBridgeError('invalid missing OCR')
                        elif type(confidence) is not int or not 0 <= confidence <= 1000 or reason is not None:
                            raise VisionBridgeError('invalid OCR confidence')
                        clean.update({key:item[key] for key in ocr_keys})
                converted.append(clean)
            result[key]=converted
        if ('marks' in row) != ('marks_png' in row) or ('crop_dir' in row) != ('crop_pngs' in row):
            raise VisionBridgeError('missing companion path')
        for key in ('marks_png','crop_dir'):
            if key in row: _ram_path(row[key])
        if 'crop_pngs' in row:
            if not isinstance(row['crop_pngs'],list) or len(row['crop_pngs']) != len(row['crops']):
                raise VisionBridgeError('invalid crop paths')
            for path in row['crop_pngs']: _ram_path(path)
        result['mark_cap_reached'] = len(row.get('marks',[])) == 24
        return result
    except (ValueError, TypeError, KeyError, OverflowError, OSError, RecursionError) as exc:
        raise VisionBridgeError('invalid description') from exc


def describe(frame, *, transport):
    from .tools import _check_frame
    _check_frame(frame)
    rc, stdout = transport(copy.deepcopy(frame))
    if type(rc) is not int or rc != 0:
        raise VisionBridgeError('description refused')
    result = parse_description(stdout)
    if (result['frame_sha256'],result['width'],result['height']) != (frame['sha256'],frame['width'],frame['height']):
        raise VisionBridgeError('frame binding mismatch')
    return result


def describe_observation(frame, *, transport):
    """Emit integer-only observation geometry, without inventing element state."""
    from .observe import validate_observation
    result = describe(frame, transport=transport)
    observation = {'schema': 'observation/v0.2', 'frame_ref': copy.deepcopy(frame),
                   'vision': {'summary': '', 'elements': [], 'changed_regions': [
                       {key: region[key] for key in ('x', 'y', 'w', 'h')}
                       for region in result['changed_regions']]}}
    validate_observation(observation, surface_id=frame['surface_id'],
                         generation=frame['generation'], contract_version='v0.2')
    return observation
