"""A Word-for-the-web-like test page (the app in a cross-origin frame, a ribbon of plain divs)."""
FRAME = b"""<!doctype html><html><head><meta charset=utf-8><style>
body{margin:0;font:15px 'Segoe UI',system-ui;background:#f3f2f1} .ribbon{display:flex;gap:4px;background:#185abd;padding:8px 14px}
.tab{color:#fff;padding:7px 14px;border-radius:4px} .pane{display:none;position:absolute;inset:44px auto 0 0;width:260px;background:#0f3d8a;color:#fff;padding:12px 0}
.pane div{padding:11px 22px} .sub{display:none;position:absolute;left:280px;top:90px;width:340px;background:#fff;box-shadow:0 6px 24px #0004}
.sub div{padding:14px 18px;border-bottom:1px solid #eee} .dlg{display:none;position:absolute;left:35%;top:35%;width:360px;background:#fff;box-shadow:0 10px 40px #0005;padding:22px}
.btn{display:inline-block;margin-top:16px;padding:8px 18px;background:#185abd;color:#fff;border-radius:4px}
.doc{margin:30px auto;width:620px;min-height:420px;background:#fff;box-shadow:0 1px 6px #0003;padding:40px}
</style></head><body>
<div class=ribbon><div class=tab id=file>File</div><div class=tab>Home</div><div class=tab>Insert</div><div class=tab>Layout</div><div class=tab>References</div><div class=tab>View</div></div>
<div class=pane id=pane><div>Home</div><div>New</div><div>Open</div><div>Info</div><div>Save a Copy</div><div>Print</div><div>Share</div><div id=export>Export</div></div>
<div class=sub id=sub><div id=dlpdf><b>Download as PDF</b><br><small>Export document as a PDF</small></div><div><b>Download as ODT</b><br><small>OpenDocument text</small></div></div>
<div class=dlg id=dlg>Your PDF is ready.<br><span class=btn id=download>Download</span></div>
<div class=doc><h2>SIT379 Report</h2><p>Lorem ipsum dolor sit amet.</p><p id=o>status: idle</p></div>
<script>const $=id=>document.getElementById(id), out=t=>$('o').textContent='status: '+t
$('file').onclick=()=>{$('pane').style.display='block';out('file')}
$('export').onclick=()=>{$('sub').style.display='block';out('export')}
$('dlpdf').onclick=()=>{$('pane').style.display=$('sub').style.display='none';$('dlg').style.display='block';out('dialog')}
$('download').onclick=()=>{$('dlg').style.display='none';out('downloaded pdf')}</script></body></html>"""
