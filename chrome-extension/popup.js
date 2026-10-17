const version = chrome.runtime.getManifest().version
document.getElementById('ver').textContent = 'v' + version
chrome.runtime.sendMessage({ type: 'status' }, (res) => {
  const on = !!(res && res.connected)
  const latest = (res && res.latest) || ''
  document.getElementById('s').className = 'status ' + (on ? 'on' : 'off')
  document.getElementById('t').textContent = on ? 'Connected to VYRSE' : 'VYRSE isn’t running'
  document.getElementById('d').textContent = on
    ? 'Ask VYRSE and it can read, highlight and click in this Chrome. While it clicks or types, Chrome shows a “started debugging” bar.'
    : 'Start VYRSE on this PC; this connects by itself within half a minute.'
  if (on && latest && latest !== version) {
    const b = document.getElementById('update')
    b.style.display = 'block'
    b.textContent = `Update ready (v${latest}): reload me`
    b.onclick = () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id })
  }
})
