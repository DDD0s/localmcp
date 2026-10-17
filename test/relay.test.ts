import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Assembly,frames,parseFrame} from '../src/relay-protocol.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';

test('relay framing preserves large Unicode/image payloads and rejects invalid sequences',()=>{
  const value={text:'中文😀'.repeat(30000),content:[{type:'image',mimeType:'image/png',data:'a'.repeat(300000)}]};
  const assembly=new Assembly();let result:any;
  for(const raw of frames('request-1',value))result=assembly.push(parseFrame(raw));
  assert.deepEqual(result.value,value);
  assert.throws(()=>parseFrame('{"id":"x","index":0,"total":99999,"data":""}'));
  assert.throws(()=>new Assembly().push({id:'x',index:1,total:2,data:''}));
});
test('Worker + Durable Object + local agent: authenticated MCP, chunking and reconnect', {timeout:90000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'localmcp-relay-'));
  const children:ChildProcess[]=[];
  t.after(async()=>{await cli('stop').catch(()=>{});for(const c of children)c.kill('SIGTERM');await new Promise(r=>setTimeout(r,2000));for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');await rm(root,{recursive:true,force:true});});
  const port=20000+Math.floor(Math.random()*15000),origin=`http://127.0.0.1:${port}`;
  const agentToken='b'.repeat(64),mcpToken='c'.repeat(64),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  const worker=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--config',resolve('wrangler.jsonc'),'--local','--port',String(port),'--inspector-port','0','--persist-to',join(root,'state'),'--var',`AGENT_TOKEN_HASH:${hash(agentToken)}`,'--var',`MCP_TOKEN_HASH:${hash(mcpToken)}`],{stdio:['ignore','pipe','pipe']});children.push(worker);
  let logs='';worker.stdout?.on('data',c=>{logs+=c;});worker.stderr?.on('data',c=>{logs+=c;});
  let ready=false;
  for(let i=0;i<200;i++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,logs);
  const legacyUrl=`${origin}/mcp/${mcpToken}`;
  assert.equal((await fetch(legacyUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503);
  assert.equal((await fetch(origin+'/mcp/bad',{method:'POST'})).status,404);
  assert.equal((await fetch(legacyUrl,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(origin+'/agent',{headers:{Authorization:`Bearer ${mcpToken}`}})).status,404);
  const registration=await fetch(origin+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(registration.status,201);
  const registered:any=await registration.json();assert.match(registered.deviceId,/^[0-9a-f-]{36}$/);assert.equal(registered.agentToken.length,64);assert.equal(registered.mcpToken.length,64);
  const url=registered.mcpUrl;const post=()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal((await post()).status,503);
  const rebound=await fetch(origin+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:registered.deviceId,agentToken:registered.agentToken,mcpToken:registered.mcpToken})});
  assert.equal(rebound.status,201);
  assert.equal((await rebound.json()).mcpUrl,url);
  const clash=await fetch(origin+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:registered.deviceId,agentToken:'d'.repeat(64),mcpToken:registered.mcpToken})});
  assert.equal(clash.status,409);
  const firstSocket=new WebSocket(origin.replace('http:','ws:')+`/agent/${registered.deviceId}`,{headers:{Authorization:`Bearer ${registered.agentToken}`}});
  await new Promise<void>((resolve,reject)=>{firstSocket.once('open',()=>resolve());firstSocket.once('error',reject);});
  const blocked=new WebSocket(origin.replace('http:','ws:')+`/agent/${registered.deviceId}`,{headers:{Authorization:`Bearer ${registered.agentToken}`}});
  const blockedResult=await new Promise<{status:number;body:string}>((resolve,reject)=>{blocked.on('unexpected-response',(_req,res)=>{const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>{blocked.terminate();resolve({status:res.statusCode||0,body:Buffer.concat(chunks).toString()});});});blocked.on('error',()=>{});blocked.on('open',()=>{blocked.close();reject(new Error('Duplicate accepted'));});});
  assert.equal(blockedResult.status,409);
  assert.match(blockedResult.body,/agent_already_connected/);
  const takeover=new WebSocket(origin.replace('http:','ws:')+`/agent/${registered.deviceId}`,{headers:{Authorization:`Bearer ${registered.agentToken}`,'x-localmcp-takeover':'1'}});
  const [takeoverOpen,firstClose]=await Promise.all([
    new Promise<void>((resolve,reject)=>{takeover.once('open',()=>resolve());takeover.once('error',reject);}),
    new Promise<number>((resolve)=>firstSocket.once('close',code=>resolve(code))),
  ]);
  assert.equal(takeoverOpen,undefined);
  assert.equal(firstClose,4000);
  takeover.close();
  await new Promise(r=>setTimeout(r,100));
  assert.equal((await fetch(`${origin}/mcp/${registered.deviceId}/${mcpToken}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
  await mkdir(join(root,'.localmcp'));
  await writeFile(join(root,'.localmcp/worker.json'),JSON.stringify({workerUrl:origin,agentToken:registered.agentToken,mcpToken:registered.mcpToken,deviceId:registered.deviceId}));
  async function cli(command?: string) {
    return new Promise<{code:number;output:string}>((done, reject) => {
      const child=spawn(process.execPath,[resolve('dist/index.js'),...(command?[command]:[])],{cwd:root,env:{...process.env,HOME:root,USERPROFILE:root,LOCALMCP_ROOT:root,LOCALMCP_AGENT_PORT:String(port+1),LOCALMCP_SHELL:'0'},stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI did not return: '+output));},25000);
      child.on('error',reject);
      child.on('close',code=>{clearTimeout(timer);const result={code:code??1,output};if(code===0||command==='status'||command==='health')done(result);else reject(new Error(output));});
    });
  }
  const stopped=await cli('status');
  assert.equal(stopped.code,1);
  assert.match(stopped.output, /Status: stopped/);
  // Stale PID files must never cause signals to be sent to another process.
  await writeFile(join(root,'.localmcp/agent.pid'),String(process.pid));
  assert.match((await cli('stop')).output, /Status: stopped/);
  await assert.rejects(cli('reload'), /LocalMCP is stopped/);
  const starts=await Promise.all([cli(),cli(),cli('start')]);
  const pid=starts[0].output.match(/PID: (\d+)/)?.[1];
  assert.ok(pid);
  for(const {output} of starts) {
    assert.match(output,/Status: running/);
    assert.ok(output.includes(url));
    assert.equal(output.match(/PID: (\d+)/)?.[1],pid);
    assert.ok(output.includes('Config: '+join(root,'.localmcp/localmcp.json')));
    assert.ok(output.includes('Log: '+join(root,'.localmcp/agent.log')));
  }
  const running=await cli('status');
  assert.equal(running.code,0);
  assert.match(running.output,new RegExp('PID: '+pid));
  const client=new Client({name:'worker-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const tools=await client.listTools();assert.equal(tools.tools.length,20);
  const content='中文😀'.repeat(25000);
  assert.equal((await client.callTool({name:'write_file',arguments:{path:'relay.txt',content}})).isError,undefined);
  const result:any=await client.callTool({name:'read_file',arguments:{path:'relay.txt'}});
  assert.equal(JSON.parse(result.content[0].text).content,content);
  // A second agent must not take over the owner connection.
  const duplicate=new WebSocket(origin.replace('http:','ws:')+`/agent/${registered.deviceId}`,{headers:{Authorization:`Bearer ${registered.agentToken}`}});
  const status=await new Promise<number>((resolve,reject)=>{duplicate.on('unexpected-response',(_req,res)=>{res.resume();duplicate.terminate();resolve(res.statusCode!);});duplicate.on('error',()=>{});duplicate.on('open',()=>{duplicate.close();reject(new Error('Duplicate accepted'));});});
  assert.equal(status,409);
  const configPath=join(root,'.localmcp/localmcp.json');
  const originalConfig=await readFile(configPath,'utf8');
  await writeFile(configPath,'{invalid');
  await assert.rejects(cli('reload'), /Invalid JSON/);
  assert.equal((await client.listTools()).tools.length,20);
  const changedConfig=JSON.parse(originalConfig);
  changedConfig.workspaces={reloaded:root};changedConfig.defaultWorkspace='reloaded';
  changedConfig.mcpServers={fixture:{command:process.execPath,args:[resolve('test/fixtures/mcp-server.mjs')]}};
  await writeFile(configPath,JSON.stringify(changedConfig));
  let hot=false;
  for(let i=0;i<100;i++){
    const info:any=await client.callTool({name:'list_workspaces',arguments:{}});
    if(JSON.parse(info.content[0].text).defaultWorkspace==='reloaded'){hot=true;break;}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(hot,'configuration should update without a reload command');
  const reloaded=await cli('status');
  assert.ok(reloaded.output.includes(url));
  assert.match(reloaded.output,new RegExp('PID: '+pid));
  const workspaces:any=await client.callTool({name:'list_workspaces',arguments:{}});
  assert.ok(workspaces.content[0].text.includes('reloaded'));
  assert.deepEqual(await client.listTools(),tools);
  const external:any=await client.callTool({name:'list_mcp_tools',arguments:{server:'fixture'}});
  assert.equal(JSON.parse(external.content[0].text).tools[0].name,'echo');
  const echoed:any=await client.callTool({name:'call_mcp_tool',arguments:{server:'fixture',tool:'echo',arguments:{text:'through relay'}}});
  assert.equal(echoed.isError,false);
  assert.equal(echoed.content[1].type,'image');
  assert.equal((await client.listTools()).tools.length,20);
  await client.close();
  assert.match((await cli('stop')).output,/Status: stopped/);
  assert.match((await cli('stop')).output,/Status: stopped/);
  assert.equal((await post()).status,503);
  assert.match((await cli()).output,/Status: running/);
  const second=new Client({name:'reconnect-test',version:'1'});await second.connect(new StreamableHTTPClientTransport(new URL(url)));
  assert.equal((await second.listTools()).tools.length,20);await second.close();
  await cli('stop');
  const identity=JSON.parse(await readFile(join(root,'.localmcp/identity.json'),'utf8'));
  assert.equal(identity.deviceId,registered.deviceId);
  assert.equal(identity.mcpToken,registered.mcpToken);
  await rm(join(root,'.localmcp/worker.json'));
  const restored=await cli();
  assert.equal(restored.code,0);
  assert.ok(restored.output.includes(url));
  const healthy=await cli('health');
  assert.equal(healthy.code,0);
  assert.match(healthy.output,/healthy/);
  assert.match(healthy.output,/protocol: 2/);
  await cli('stop');
  await writeFile(join(root,'.localmcp/worker.json'),'{invalid');
  await assert.rejects(cli(), /startup failed/);
  assert.match((await cli('status')).output, /Status: stopped/);
});
