/** Lower only ESM import binding syntax; unknown forms fail before evaluation. */
export function sfcImportBinding(binding) {
 const text=binding.trim(), identifier='[A-Za-z_$][\\w$]*';
 if(new RegExp('^'+identifier+'$').test(text))return text;
 const namespace=new RegExp('^\\*\\s+as\\s+('+identifier+')$').exec(text);
 if(namespace)return namespace[1];
 if(!text.startsWith('{')||!text.endsWith('}'))throw Error('Unsupported SFC import binding');
 const entries=text.slice(1,-1).split(',').map(x=>x.trim()).filter(Boolean);
 if(!entries.length)throw Error('Empty SFC import binding');
 return '{'+entries.map(entry=>{
  const match=new RegExp('^('+identifier+')(?:\\s+as\\s+('+identifier+'))?$').exec(entry);
  if(!match)throw Error('Unsupported SFC named import binding');
  return match[2]?match[1]+': '+match[2]:match[1];
 }).join(', ')+'}';
}
