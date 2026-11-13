import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inflateRawSync} from 'node:zlib';
import {docx,exportDocument} from '../server/export.mjs';

const exec=promisify(execFile);
function response(){return {status:null,headers:null,body:null,writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;return this;}};}
function unpack(buffer){
  const files={};let offset=0;
  while(buffer.readUInt32LE(offset)===0x04034b50){
    const length=buffer.readUInt32LE(offset+18),nameLength=buffer.readUInt16LE(offset+26),extraLength=buffer.readUInt16LE(offset+28);
    const name=buffer.subarray(offset+30,offset+30+nameLength).toString();
    const start=offset+30+nameLength+extraLength;
    files[name]=inflateRawSync(buffer.subarray(start,start+length)).toString();
    offset=start+length;
  }
  assert.equal(buffer.readUInt32LE(offset),0x02014b50);return files;
}

test('DOCX is an intact ZIP with valid XML, keeping Unicode and hostile text literal',async t=>{
  const content='# Título com ação 😃\n\n<test attribute="x">& </w:t><script>alert(1)</script>\nControl\u0000\u0001 kept\n';
  const zip=docx(content),files=unpack(zip);
  assert.deepEqual(Object.keys(files),['[Content_Types].xml','_rels/.rels','word/document.xml']);
  assert(files['word/document.xml'].includes('&lt;script&gt;'));assert(!files['word/document.xml'].includes('<script>'));
  const directory=await mkdtemp(path.join(tmpdir(),'mc-export-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'fixture.docx');await writeFile(file,zip);
  const python="import json,sys,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; [E.fromstring(z.read(n)) for n in z.namelist()]; root=E.fromstring(z.read('word/document.xml')); print(json.dumps([n.text or '' for n in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')],ensure_ascii=False))";
  const result=JSON.parse((await exec('python3',['-B','-c',python,file])).stdout);
  assert.equal(result[0],'Título com ação 😃');assert(result.some(line=>line.includes('<script>alert(1)</script>')));assert(result.some(line=>line==='Control kept'));
});

test('MD/TXT export keeps the saved version exactly and produces safe download names',()=>{
  const content='# Árvore\r\n\r\n<script>text</script>\r\n';
  for(const format of ['md','txt']) {
    const res=response();exportDocument(res,{name:'relatório\r\nX-Injected: evil.md',content},format);
    assert.equal(res.status,200);assert.equal(res.body.toString(),content);
    assert(!/[\r\n]/.test(res.headers['Content-Disposition']));assert(res.headers['Content-Disposition'].includes('filename*=UTF-8'));
  }
});

test('HTML for PDF escapes document and title, with no scripts or attributes from the text',()=>{
  const res=response();
  exportDocument(res,{name:'</title><script>name()</script>.md',content:'</pre><img src=x onerror="attack()"><script>alert(1)</script>& “ação”'},'pdf');
  const html=res.body;
  assert.equal(res.headers['Content-Type'],'text/html; charset=utf-8');
  assert(!html.includes('<img'));assert(!html.includes('<script>alert'));assert(!html.includes('<script>name'));
  assert(html.includes('&lt;/pre&gt;&lt;img src=x onerror=&quot;attack()&quot;&gt;'));
  assert.equal((html.match(/<script\b/g)||[]).length,1);assert(html.includes('<script src="/print.js"></script>'));
  assert(html.includes('Save as PDF'));assert(html.includes('saved version'));assert(html.includes('<html lang="en-US">'));
  const pt=response();exportDocument(pt,{name:'x.md',content:'x'},'pdf','pt');
  assert(pt.body.includes('Salvar como PDF'));assert(pt.body.includes('versão salva'));assert(pt.body.includes('<html lang="pt-BR">'));
});

test('DOCX download has the right MIME type and extension; an unexpected format is refused',()=>{
  const res=response();exportDocument(res,{name:'Memória do projeto.md',content:'# Example'},'docx');
  assert.equal(res.headers['Content-Type'],'application/vnd.openxmlformats-officedocument.wordprocessingml.document');assert(res.headers['Content-Disposition'].includes('.docx'));
  assert(unpack(res.body)['word/document.xml'].includes('Example'));
  assert.throws(()=>exportDocument(response(),{name:'x.md',content:'x'},'html'),{status:400});
});
