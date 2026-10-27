import postcss from 'postcss';

// Match whole selectors in parsed lists and collect every matching rule.
export function declarationsFor(styles, selector) {
  const declarations = [];
  postcss.parse(styles).walkRules(rule => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls(declaration => declarations.push(declaration.toString()));
    }
  });
  return declarations.join(';');
}
