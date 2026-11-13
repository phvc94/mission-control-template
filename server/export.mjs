import {deflateRawSync} from 'node:zlib';
import {AppError} from './errors.mjs';
import {i18n,t} from './i18n.mjs';
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu,'');
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function zip(files){const parts=[],directory=[];let offset=0;for(const [name,content] of Object.entries(files)){
  const file=Buffer.from(content),filename=Buffer.from(name),data=deflateRawSync(file),crc=crc32(file),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(file.length,22);h.writeUInt16LE(filename.length,26);parts.push(h,filename,data);
  const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt16LE(0x800,8);d.writeUInt16LE(8,10);d.writeUInt32LE(crc,16);d.writeUInt32LE(data.length,20);d.writeUInt32LE(file.length,24);d.writeUInt16LE(filename.length,28);d.writeUInt32LE(offset,42);directory.push(d,filename);offset+=h.length+filename.length+data.length;
}const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,central,end]);}
export function docx(content){return zip({
  '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+content.split('\n').map(line=>`<w:p><w:r>${/^#{1,6} /.test(line)?'<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>':''}<w:t xml:space="preserve">${xml(line.replace(/^#{1,6} /,''))}</w:t></w:r></w:p>`).join('')+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'
});}
// lang only affects the print page shown for PDF export; file downloads are the saved content, unchanged.
export function exportDocument(res,document,format,lang='en'){
 if(!['md','txt','docx','pdf'].includes(format))throw new AppError('Unsupported format.');
 const stem=(document.name||'document').replace(/\.[^.]+$/,'').replace(/[^\p{L}\p{N}_. -]/gu,'_');
 if(format==='pdf'){
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   return res.end(`<!doctype html><html lang="${i18n.locale(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(stem)}</title><style>body{max-width:800px;margin:30px auto;padding:24px;font:16px/1.65 Georgia,serif;color:#222;background:#fff}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}button{padding:10px 16px}small{display:block;font:13px system-ui;margin:12px 0}@page{size:A4;margin:20mm}@media print{nav{display:none}body{margin:0;padding:0}}</style><nav><button id="print">${xml(t(lang,'Print / Save as PDF'))}</button><small>${xml(t(lang,'Choose “Save as PDF” in the browser dialog. The export contains the saved version of the file.'))}</small></nav><pre>${xml(document.content)}</pre><script src="/print.js"></script></html>`);
 }
 const data=format==='docx'?docx(document.content):Buffer.from(document.content);
 res.writeHead(200,{'Content-Type':format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="document.${format}"; filename*=UTF-8''${encodeURIComponent(stem+'.'+format)}`});return res.end(data);
}
