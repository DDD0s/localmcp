import { realpath, stat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { McpServerConfig } from './mcp/loader.js';

const mcpEntrySchema=z.object({enabled:z.boolean().optional().default(true),command:z.string().min(1),args:z.array(z.string()).optional().default([]),env:z.record(z.string(),z.string()).optional()}).strict();
export const localMcpConfigSchema=z.object({
  root:z.string().optional(),
  workspaces:z.record(z.string().min(1),z.string().min(1)).optional(),
  defaultWorkspace:z.string().min(1).optional(),
  features:z.object({files:z.boolean().optional().default(true),fileWrites:z.boolean().optional().default(true),shell:z.boolean().optional().default(true),processes:z.boolean().optional().default(true)}).strict().optional().default({files:true,fileWrites:true,shell:true,processes:true}),
  allowedDirectories:z.array(z.string().min(1)).max(100).optional(),
  skills:z.object({dir:z.string().optional().default('skills'),enabled:z.array(z.string().min(1)).optional()}).strict().optional().default({dir:'skills'}),
  mcpServers:z.record(z.string(),mcpEntrySchema).optional().default({}),
}).strict();
type FileConfig=z.infer<typeof localMcpConfigSchema>;
export interface Config {root:string;workspaces:Record<string,string>;defaultWorkspace:string;files:boolean;fileWrites:boolean;shell:boolean;processes:boolean;allowedDirectories:string[];port:number;token?:string;skillsDir:string;enabledSkills?:string[];mcpServers:Record<string,McpServerConfig>;configFile?:string}

function parseConfig(raw:unknown,path:string):FileConfig{
 const result=localMcpConfigSchema.safeParse(raw);if(result.success)return result.data;
 const details=result.error.issues.map(i=>`${i.path.join('.')||'<root>'}: ${i.message}`).join('; ');
 throw new Error(`Invalid LocalMCP config ${path}: ${details}`);
}
async function readConfig():Promise<{value:FileConfig;base:string;path?:string}>{
 const explicit=process.env.LOCALMCP_CONFIG,path=explicit?resolve(explicit):resolve(homedir(),'.localmcp','localmcp.json');
 try{return {value:parseConfig(JSON.parse(await readFile(path,'utf8')),path),base:dirname(path),path};}
 catch(e:any){if(e instanceof SyntaxError)throw new Error(`Invalid JSON in LocalMCP config ${path}: ${e.message}`);if(e.code!=='ENOENT')throw e;return {value:localMcpConfigSchema.parse({}),base:homedir()};}
}
export function configFilePath(){return resolve(process.env.LOCALMCP_CONFIG||resolve(homedir(),'.localmcp','localmcp.json'));}
function parseSnapshot(content:string,path:string){try{return parseConfig(JSON.parse(content),path);}catch(error){if(error instanceof SyntaxError)throw new Error(`Invalid JSON in LocalMCP config ${path}: ${error.message}`);throw error;}}
export async function config(snapshot?:{content:string;path:string}):Promise<Config>{
 const loaded=snapshot?{value:parseSnapshot(snapshot.content,snapshot.path),base:dirname(snapshot.path),path:snapshot.path}:await readConfig(),c=loaded.value;
 const configured=c.workspaces&&Object.keys(c.workspaces).length?c.workspaces:{default:c.root||'.'};
 const rootOverride=process.env.LOCALMCP_ROOT;
 const expand=(path:string)=>path==='~'||path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(loaded.base,path);
 const workspaces:Record<string,string>={};for(const [name,path] of Object.entries(configured)){const selected=rootOverride&&name===(c.defaultWorkspace||Object.keys(configured)[0])?rootOverride:path;const root=await realpath(expand(selected));if(!(await stat(root)).isDirectory())throw new Error(`Workspace '${name}' must be a directory`);workspaces[name]=root;}
 const defaultWorkspace=c.defaultWorkspace||Object.keys(workspaces)[0];if(!workspaces[defaultWorkspace])throw new Error(`Unknown defaultWorkspace '${defaultWorkspace}'`);
 const root=workspaces[defaultWorkspace];
 const allowedDirectories:string[]=[];
 for(const entry of c.allowedDirectories??[]){
  const selected=expand(entry);
  try{const real=await realpath(selected);if(!(await stat(real)).isDirectory())throw new Error(`allowedDirectories entry is not a directory: ${entry}`);allowedDirectories.push(real);}
  catch(error:any){if(error.code!=='ENOENT')throw error;allowedDirectories.push(selected);}
 }
 const port=Number(process.env.LOCALMCP_PORT||8787);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid LOCALMCP_PORT');
 const mcpServers:Record<string,McpServerConfig>={};for(const [name,m] of Object.entries(c.mcpServers))if(m.enabled)mcpServers[name]={command:m.command,args:m.args,env:m.env};
 const shell=process.env.LOCALMCP_SHELL!==undefined?process.env.LOCALMCP_SHELL==='1':c.features.shell;
 const fileWrites=process.env.LOCALMCP_FILE_WRITES!==undefined?process.env.LOCALMCP_FILE_WRITES==='1':c.features.fileWrites;
 return {root,workspaces,defaultWorkspace,files:c.features.files,fileWrites,shell,processes:c.features.processes&&shell,allowedDirectories,port,token:process.env.LOCALMCP_TOKEN,skillsDir:resolve(loaded.base,c.skills.dir),enabledSkills:c.skills.enabled,mcpServers,configFile:loaded.path};
}
