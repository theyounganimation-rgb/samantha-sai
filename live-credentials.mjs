import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
let cached;
export async function readLiveKey(){
  if(process.env.SAI_LIVE_API_KEY)return process.env.SAI_LIVE_API_KEY;
  if(cached)return cached;
  try{
    const {stdout}=await exec('/usr/bin/security',['find-generic-password','-s','Artemis.OpenAI','-a','Artemis','-w'],{timeout:60000,maxBuffer:16384});
    return cached=stdout.trim();
  }catch{throw Error('The saved OpenAI voice key is unavailable in Mac Keychain.');}
}
