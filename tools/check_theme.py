#!/usr/bin/env python3
"""G-THEME: offline token/CSS contrast and package font gate.

[TARGET, unit decision] contrastPairs is the authoritative usage matrix; also
check explicit foreground/background token pairs in application CSS/Vue rules.
Inherited text is covered conservatively by the matrix's surface combinations.
Unresolved values, empty matrices and generated CSS drift fail closed.
"""
import argparse
import json
from pathlib import Path
import re
import sys

FONT_EXTENSIONS = {'.woff', '.woff2', '.ttf', '.otf'}


def css_name(path):
    return '--mv-' + re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', path).replace('.', '-').lower()


def contrast(a, b):
    def luminance(value):
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
            raise ValueError('unresolved colour: ' + value)
        channels = [int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
        return sum(v * weight for v, weight in zip(linear, (.2126, .7152, .0722)))
    first, second = sorted((luminance(a), luminance(b)))
    return (second + .05) / (first + .05)


def check(root):
    root = Path(root)
    source = root / 'ui/src'
    for directory in (source, root / 'ui/public', root / 'ui/dist', root / 'dist'):
        if directory.exists():
            for path in directory.rglob('*'):
                if path.suffix.lower() in FONT_EXTENSIONS:
                    raise ValueError('G-PKG bundled font: ' + str(path.relative_to(root)))
    data = json.loads((source / 'design/metaviewer.tokens.json').read_text())
    css = (source / 'design/metaviewer.css').read_text()
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    blocks = dict(re.findall(r'([^{}]+)\{([^{}]*)\}', css.split('@media', 1)[0]))

    def declarations(body):
        return dict(re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', body))

    def block(selector):
        matches = [body for head, body in blocks.items() if head.strip() == selector]
        if len(matches) != 1:
            raise ValueError('missing/ambiguous theme selector: ' + selector)
        return declarations(matches[0])

    matrix = data.get('contrastPairs')
    if not isinstance(matrix, list) or not matrix:
        raise ValueError('empty contrast usage matrix')
    if any(not isinstance(pair, dict) or set(pair) != {'foreground', 'background'}
           or any(not isinstance(value, str) or not value for value in pair.values())
           for pair in matrix):
        raise ValueError('invalid contrast usage matrix')
    pairs = {(css_name(pair['foreground']), css_name(pair['background'])) for pair in matrix}
    # Catch a new explicit CSS pair even before its author updates the matrix.
    for path in sorted(source.rglob('*')):
        if path.suffix not in ('.css', '.vue') or path.name == 'metaviewer.css':
            continue
        text = re.sub(r'/\*.*?\*/', '', path.read_text(), flags=re.S)
        for body in re.findall(r'\{([^{}]*)\}', text):
            foreground = re.search(r'(?:^|;)\s*color\s*:\s*var\((--(?:mv|cuk)-[\w-]+)', body)
            background = re.search(r'(?:^|;)\s*background(?:-color)?\s*:\s*var\((--(?:mv|cuk)-[\w-]+)', body)
            if foreground and background:
                pairs.add(tuple(item.group(1).replace('--cuk-', '--mv-') for item in (foreground, background)))

    count = 0
    for scheme in ('mv-light', 'mv-dark'):
        # Public renderer schemes map to the kit's underlying CSS/token modes.
        mode = scheme.removeprefix('mv-')
        values = block(':root')
        values.update(block(f':root[data-theme-scheme="{mode}"][data-theme-contrast="normal"]'))

        def resolve_css(name, seen=()):
            if name in seen or name not in values:
                raise ValueError('unresolved/cyclic CSS token: ' + name)
            value = values[name].strip()
            match = re.fullmatch(r'var\((--[\w-]+)\)', value)
            return resolve_css(match[1], (*seen, name)) if match else value

        def resolve_token(path, seen=()):
            if path in seen:
                raise ValueError('cyclic token: ' + path)
            node = data
            for key in path.split('.'):
                node = node[key]
            value = node['modes'][mode + '.normal'] if 'modes' in node else node['$value']
            match = re.fullmatch(r'\{([^{}]+)\}', value)
            return resolve_token(match[1], (*seen, path)) if match else value

        for pair in matrix:
            for path in pair.values():
                if resolve_token(path).lower() != resolve_css(css_name(path)).lower():
                    raise ValueError(f'generated CSS differs from token: {scheme} {path}')
        for foreground, background in sorted(pairs):
            ratio = contrast(resolve_css(foreground), resolve_css(background))
            if ratio < 4.5:
                raise ValueError(f'G-THEME {scheme} {foreground}/{background}: {ratio:.4f}:1 < 4.5:1')
            count += 1
        for family, first in (('sans', 'system-ui'), ('mono', 'ui-monospace')):
            path = 'semantic.typography.fontFamily.' + family
            stack = resolve_css(css_name(path))
            if stack != resolve_token(path) or stack.split(',')[0].strip() != first:
                raise ValueError('G-THEME requires SYSTEM font stack: ' + family)
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        count = check(args.root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f'PASS G-THEME: {count} contrast pairs [MEASURED]; mv-light/mv-dark; no bundled fonts')
    return 0


if __name__ == '__main__':
    sys.exit(main())
