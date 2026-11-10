import fs from 'node:fs';
import { Account, JsonRpcProvider, actions } from 'near-api-js';
const ENV='/Users/user/Projects/Web3/Hackathon/Valtrum on NEAR/Code/.env';
export const env={};
for (const l of fs.readFileSync(ENV,'utf8').split('\n')){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
export const provider=new JsonRpcProvider({url:'https://test.rpc.fastnear.com'});
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function retry(f,n=6){let e;for(let i=0;i<n;i++){try{return await f();}catch(x){e=x;const s=String(x?.message||x);if(/429|Too Many|timeout|fetch failed|ECONN/i.test(s)){await sleep(1500*(i+1));continue;}throw x;}}throw e;}
export function acct(role){
  const id=env[`TESTNET_${role}_ACCOUNT_ID`];const k=env[`TESTNET_${role}_PRIVATE_KEY`];
  if(!id||!k)throw new Error('missing '+role);
  return new Account(id,provider,k);
}
export async function view(contractId,method,args={}){return retry(()=>provider.callFunction({contractId,method,args}));}
export async function balance(id){const s=await retry(()=>provider.viewAccount({accountId:id}));return {amount:BigInt(s.amount),locked:BigInt(s.locked),storage:s.storage_usage,code:s.code_hash};}
export const near=(y)=>(Number(BigInt(y)/10n**18n)/1e6).toFixed(4);
export const N=(s)=>BigInt(Math.round(parseFloat(s)*1e6))*10n**18n;
export const TGAS=(t)=>BigInt(t)*10n**12n;
export async function call(account,contractId,methodName,args,{gas=100,deposit=0n}={}){
  try{
    const r=await account.signAndSendTransaction({receiverId:contractId,actions:[actions.functionCall(methodName,args,TGAS(gas),BigInt(deposit))]});
    const st=r.status; const hash=r.transaction?.hash||r.transaction_outcome?.id;
    const fail=st&&st.Failure;
    return {ok:!fail,hash,status:st,err:fail?JSON.stringify(fail):null};
  }catch(e){
    return {ok:false,hash:e.txHash||e.transactionHash||e.context?.transactionHash||e.transaction_outcome?.id||null,err:String(e.message||e).slice(0,700)};
  }
}
export function b64(o){return Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64');}
export function appendEnv(pairs){let s='';for(const [k,v] of Object.entries(pairs))s+=`${k}=${v}\n`;const cur=fs.readFileSync(ENV,'utf8');fs.appendFileSync(ENV,(cur.endsWith('\n')?'':'\n')+s);fs.chmodSync(ENV,0o600);}
