import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fork,execFile} from 'node:child_process';
import {createConnection} from 'node:net';
import {controlEndpoint} from '../src/control-endpoint.js';

test('control endpoints use normalized, directory-specific Windows pipes and Unix socket files',()=>{
  const endpoint=controlEndpoint('C:\\Users\\chy\\.localmcp','win32');
  assert.match(endpoint.address,/^\\\\\.\\pipe\\localmcp-[a-f0-9]{32}$/);
  assert.equal(endpoint.socketFile,undefined);
  assert.deepEqual(endpoint,controlEndpoint('c:/users/CHY/.localmcp/','win32'));
  assert.notEqual(endpoint.address,controlEndpoint('C:\\Users\\other\\.localmcp','win32').address);
  for(const platform of ['darwin','linux'] as const){
    const dir=resolve('test-state');
    assert.deepEqual(controlEndpoint(dir,platform),{address:join(dir,'agent.sock'),socketFile:join(dir,'agent.sock')});
  }
});

test('native IPC supports status, idempotent start, reload, stop and restart', {timeout:30000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'localmcp-ipc-'));
  const env={...process.env,HOME:home,USERPROFILE:home};
  const children:ReturnType<typeof fork>[]=[];
  t.after(async()=>{for(const child of children)if(child.exitCode===null)child.kill();await new Promise(r=>setTimeout(r,200));await rm(home,{recursive:true,force:true});});
  const cli=async(command:string)=>await new Promise<{code:number;stdout:string}>((done)=>{
    execFile(process.execPath,[resolve('dist/index.js'),command],{env,timeout:10000},(error,stdout)=>{
      done({code:typeof error?.code==='number'?error.code:error?1:0,stdout:stdout??''});
    });
  });
  const stopped=await cli('status');
  assert.equal(stopped.code,1);
  assert.match(stopped.stdout,/Status: stopped/);
  for(let iteration=0;iteration<2;iteration++){
    const child=fork(resolve('test/fixtures/control-server.mjs'),[],{env,stdio:['ignore','ignore','pipe','ipc']});children.push(child);
    let errors='';child.stderr?.on('data',data=>{errors+=data;});
    await new Promise<void>((done,reject)=>{
      child.once('message',()=>done());child.once('error',reject);
      child.once('exit',code=>reject(new Error(`IPC server exited (${code}): ${errors}`)));
    });
    // A request must complete without the client half-closing the pipe.
    const response=await new Promise<string>((done,reject)=>{
      const socket=createConnection(controlEndpoint(join(home,'.localmcp')).address);
      let data='';socket.setTimeout(5000,()=>socket.destroy(new Error('IPC framing timeout')));
      socket.on('connect',()=>socket.write('status\n'));
      socket.on('data',chunk=>{data+=chunk;});socket.on('end',()=>{socket.destroy();done(data);});socket.on('error',reject);
    });
    assert.equal(JSON.parse(response).pid,child.pid);
    const running=await cli('status');
    assert.equal(running.code,0);
    assert.match(running.stdout,new RegExp(`PID: ${child.pid}`));
    assert.match((await cli('start')).stdout,new RegExp(`PID: ${child.pid}`));
    assert.match((await cli('reload')).stdout,/Config: reloads:1/);
    assert.match((await cli('stop')).stdout,/Status: stopped/);
    assert.equal((await cli('stop')).code,0);
    assert.match((await cli('status')).stdout,/Status: stopped/);
  }
});
