"""[TARGET, unit decision] Fail-closed semantic workflow reference policy.

PyYAML is a runner prerequisite, resolved before setup-python changes PATH.
No network installation or permissive parser fallback is allowed.
"""
import json
from pathlib import Path
import re
import sys

import yaml
from yaml.nodes import MappingNode, ScalarNode, SequenceNode

PIN = re.compile(r'[a-zA-Z0-9_\-]+/[a-zA-Z0-9_\-./]+@[0-9a-f]{40}')


def pin_errors(text, root):
    errors = []
    root = Path(root).resolve()
    try:
        document = yaml.compose(text, Loader=yaml.SafeLoader)
    except yaml.YAMLError as error:
        return ['invalid YAML: ' + str(error)]
    if document is None:
        return ['empty workflow']
    seen = set()

    def visit(node):
        # Aliases may share nodes or form cycles; inspect each node once.
        if id(node) in seen:
            return
        seen.add(id(node))
        if isinstance(node, MappingNode):
            keys = set()
            for key, value in node.value:
                if not isinstance(key, ScalarNode) or key.tag != 'tag:yaml.org,2002:str':
                    # YAML 1.1 resolves GitHub's `on` as a boolean. It is not a uses key.
                    if not (isinstance(key, ScalarNode) and key.value == 'on'):
                        errors.append('non-string mapping key')
                if key.value in keys:
                    errors.append('duplicate key: ' + key.value)
                keys.add(key.value)
                if key.value == '<<':
                    errors.append('YAML merge keys are not admitted')
                if key.value == 'uses':
                    ref = value.value if isinstance(value, ScalarNode) else None
                    if not isinstance(ref, str) or value.tag != 'tag:yaml.org,2002:str':
                        errors.append('uses must be a string')
                    elif ref.startswith('./'):
                        target = (root / ref).resolve()
                        if not target.is_relative_to(root) or not any(
                                (target / name).is_file() and (target / name).resolve().is_relative_to(root)
                                for name in ('action.yml', 'action.yaml')):
                            errors.append('missing local action metadata: ' + ref)
                    elif PIN.fullmatch(ref) is None or any(
                            part in ('', '.', '..') for part in ref.split('@')[0].split('/')):
                        errors.append('unpinned action: ' + ref)
                visit(value)
        elif isinstance(node, SequenceNode):
            for value in node.value:
                visit(value)
    visit(document)
    return errors


if __name__ == '__main__':
    print(json.dumps(pin_errors(sys.stdin.read(), sys.argv[1])))
