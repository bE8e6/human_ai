import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { POLICY_VERSION } from '../privacy.mjs';

const paragraphs=name=>{
  const html=readFileSync(new URL('../public/'+name+'.html',import.meta.url),'utf8');
  return [...html.matchAll(/<(h1|h2|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .map(match=>(match[1]==='li'?'• ':'')+match[2].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim()).join('\n\n');
};
const output=new URL('../../entry/src/main/ets/common/Policy.ets',import.meta.url);
writeFileSync(output,'// Generated from server/public by npm run sync:policy.\n'+
  'export const POLICY_VERSION: string = '+JSON.stringify(POLICY_VERSION)+';\n'+
  'export const PRIVACY_TEXT: string = '+JSON.stringify(paragraphs('privacy'))+';\n'+
  'export const RULES_TEXT: string = '+JSON.stringify(paragraphs('rules'))+';\n');
console.log('已同步离线政策文本：'+fileURLToPath(output));
