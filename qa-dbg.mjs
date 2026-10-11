import { chromium } from 'playwright'
const BASE='http://localhost:3000'
const r=await fetch(`${BASE}/api/auth/sign-in/email`,{method:'POST',headers:{origin:BASE,'content-type':'application/json'},body:JSON.stringify({email:'dev@localhost',password:'dev'})})
const cookies=(r.headers.getSetCookie?.()??[]).map(l=>{const [p]=l.split(';');const i=p.indexOf('=');return {name:p.slice(0,i),value:p.slice(i+1),url:BASE}})
const b=await chromium.launch({headless:true}); const c=await b.newContext({baseURL:BASE}); await c.addCookies(cookies)
const p=await c.newPage(); const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text())}); p.on('pageerror',e=>errs.push('pageerror: '+e.message))
await p.goto('/#/s/sesn_01M4P92P5Q4HD5TCJPNQNAPNPJ')
await p.waitForTimeout(5000)
console.log('articles:', JSON.stringify(await p.locator('article[data-role]').evaluateAll(n=>n.map(x=>x.getAttribute('data-role')+':'+(x.textContent||'').trim().slice(0,80)))))
console.log('slots:', JSON.stringify(await p.locator('[data-slot]').evaluateAll(n=>n.map(x=>x.getAttribute('data-slot')))))
console.log('alerts:', JSON.stringify(await p.getByRole('alert').allTextContents()))
console.log('errors:', JSON.stringify(errs.slice(0,5)))
await p.screenshot({path:'/tmp/dbg-oldlog.png', fullPage:true})
await b.close()
