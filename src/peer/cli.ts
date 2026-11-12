import type { Command } from 'commander';
import { open } from 'node:fs/promises';
import { DomainError } from '../domain/errors.js';
import type { PersonalRepository } from '../storage/personal-repository.js';
import { assertSeparateStorageRoots } from '../storage/paths.js';
import { forgetPeer, getTrustedPeer, loadIdentity, renewIdentity } from './identity.js';
import { pairFromInvitation, serveInvitation, servePeer, type PeerServer } from './transport.js';
import { PeerService } from './service.js';

type Options={project:string;personal?:string;json?:boolean;peer?:string;address?:string;bind?:string;port:string;timeout:string;readyFile?:string};
type Helpers={
  createServices(project:string,personal?:string):{personalRepository:PersonalRepository};
  addProjectOption(command:Command):Command;addPersonalOption(command:Command):Command;addJsonOption(command:Command):Command;
  respondSuccess(json:boolean,data:unknown):void;
};
function input(message:string):never{throw new DomainError('INVALID_INPUT',message);}
function integer(text:string,min:number,max:number):number{
  if(!/^\d+$/.test(text))return input('Expected an integer');
  const value=Number(text);if(!Number.isSafeInteger(value)||value<min||value>max)return input('Integer outside permitted range');return value;
}
function connection(o:Options):{peerId:string;address:string}{if(!o.peer||!o.address)return input('Peer identity and address are required');return {peerId:o.peer,address:o.address};}

/** Register peer lifecycle and business commands against the existing CLI envelope. */
export function registerPeerCommands(program:Command,h:Helpers):void{
  const peer=program.command('peer').description('direct authenticated LAN knowledge synchronization');
  const command=(parent:Command,name:string)=>h.addJsonOption(h.addPersonalOption(h.addProjectOption(parent.command(name))));
  const repository=async(o:Options)=>{const repo=h.createServices(o.project,o.personal).personalRepository;await assertSeparateStorageRoots(repo.paths);return repo;};
  const service=async(o:Options)=>new PeerService(await repository(o));
  const emit=(o:Options,data:unknown)=>h.respondSuccess(Boolean(o.json),data);
  const listener=(c:Command)=>c.requiredOption('--bind <ip>','assigned private IPv4 address').option('--port <port>','TCP port; 0 selects an available port','0').option('--timeout <ms>','bounded listener lifetime, milliseconds','300000').option('--ready-file <file>','write a private readiness event to a new file');
  const remote=(c:Command)=>c.requiredOption('--peer <id>','paired device identity').requiredOption('--address <ip:port>','numeric private IPv4 endpoint');
  const ready=async(o:Options,server:PeerServer)=>{
    const event={event:'ready',address:server.address,expiresAt:server.expiresAt};
    try{
      if(o.readyFile){const file=await open(o.readyFile,'wx',0o600);try{await file.writeFile(JSON.stringify({ok:true,data:event}));await file.sync();}finally{await file.close();}}
      emit(o,event);
      const reason=await new Promise<string>(resolve=>{
        const finish=(reason:string)=>{clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);resolve(reason);};
        const interrupt=()=>finish('interrupted'),terminate=()=>finish('terminated');
        const timer=setTimeout(()=>finish('expired'),Math.max(0,Date.parse(server.expiresAt)-Date.now()));
        process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
      });
      await server.close();emit(o,{event:'stopped',reason});
    }finally{await server.close();}
  };
  listener(command(peer,'invite')).description('open a five-minute pairing-only window; the invitation is a secret file')
    .requiredOption('--out <file>','new private invitation file').option('--refresh','refresh existing peer certificate trust').option('--peer <id>','expected existing peer for refresh')
    .action(async(o:Options&{out:string;refresh?:boolean})=>{
      const repo=await repository(o);
      if(o.refresh&&o.peer){const trusted=await getTrustedPeer(repo.paths.personal.base,o.peer);if(!trusted)input('Refresh peer is not trusted');}
      const server=await serveInvitation({personalRoot:repo.paths.personal.base,bind:o.bind!,port:integer(o.port,0,65535),timeoutMs:integer(o.timeout,1,300000),invitationPath:o.out,...(o.refresh?{refresh:true}:{})});
      await ready(o,server);
    });
  command(peer,'pair').description('pair or refresh using an explicitly transferred private invitation')
    .requiredOption('--invite-file <file>','private invitation file').option('--refresh','refresh the same existing peer identity')
    .action(async(o:Options&{inviteFile:string;refresh?:boolean})=>{const repo=await repository(o);emit(o,await pairFromInvitation({personalRoot:repo.paths.personal.base,invitationPath:o.inviteFile,...(o.refresh?{refresh:true}:{})}));});
  command(peer,'list').description('list paired device metadata without secrets').action(async(o:Options)=>{
    const repo=await repository(o),trusted=await getTrustedPeer(repo.paths.personal.base);
    emit(o,{peers:trusted?[{peerId:trusted.peerId,pairedAt:trusted.pairedAt}]:[]});
  });
  command(peer,'forget').description('explicitly remove trust and the old pair baseline; pending sessions must be resolved first').requiredOption('--peer <id>','paired device identity')
    .action(async(o:Options)=>{const repo=await repository(o);await forgetPeer(repo.paths.personal.base,o.peer!);emit(o,{forgotten:o.peer});});
  const identity=peer.command('identity').description('local device certificate lifecycle');
  command(identity,'renew').description('explicitly renew a certificate using the existing key, preserving pending work').action(async(o:Options)=>{
    const repo=await repository(o),renewed=await renewIdentity(repo.paths.personal.base);emit(o,{peerId:renewed.peerId,expiresAt:renewed.expiresAt});
  });
  listener(command(peer,'serve')).description('temporarily serve a trusted peer; modifications require --allow-apply').option('--allow-apply','allow the paired peer to apply a verified synchronization')
    .action(async(o:Options&{allowApply?:boolean})=>{
      const repo=await repository(o),sync=new PeerService(repo);
      const server=await servePeer({personalRoot:repo.paths.personal.base,bind:o.bind!,port:integer(o.port,0,65535),timeoutMs:integer(o.timeout,1,3600000),allowApply:Boolean(o.allowApply),handler:sync.handler});
      await ready(o,server);
    });
  remote(command(peer,'sync')).description('preview or explicitly apply bidirectional synchronization').option('--dry-run','preview without changing knowledge').option('--apply','recompute and apply a conflict-free plan')
    .action(async(o:Options&{dryRun?:boolean;apply?:boolean})=>{
      if(o.dryRun&&o.apply)throw new DomainError('P2P_SYNC_MODE_CONFLICT','Choose --dry-run or --apply');
      if(!o.dryRun&&!o.apply)throw new DomainError('P2P_SYNC_MODE_REQUIRED','Specify --dry-run or --apply');
      const s=await service(o);emit(o,o.apply?await s.sync(connection(o)):await s.preview(connection(o)));
    });
  const conflict=peer.command('conflict').description('inspect and explicitly resolve hash-bound file conflicts');
  remote(command(conflict,'list')).action(async(o:Options)=>emit(o,await(await service(o)).listConflicts(connection(o))));
  remote(command(conflict,'show')).requiredOption('--path <path>','conflicted personal path').action(async(o:Options&{path:string})=>emit(o,await(await service(o)).showConflict({...connection(o),path:o.path})));
  remote(command(conflict,'resolve')).requiredOption('--path <path>','conflicted personal path').requiredOption('--strategy <strategy>','local|remote|both|skip')
    .action(async(o:Options&{path:string;strategy:string})=>{
      if(!['local','remote','both','skip'].includes(o.strategy))return input('Invalid conflict strategy');
      emit(o,await(await service(o)).resolveConflict({...connection(o),path:o.path,strategy:o.strategy as 'local'|'remote'|'both'|'skip'}));
    });
  const session=peer.command('session').description('inspect and resume a recorded synchronization');
  command(session,'status').requiredOption('--peer <id>','paired device identity').option('--address <ip:port>','optionally query the peer')
    .action(async(o:Options)=>emit(o,await(await service(o)).status({peerId:o.peer!,...(o.address?{address:o.address}:{})})));
  remote(command(session,'resume')).option('--preserve-current','explicitly archive current divergent data before completing the recorded plan')
    .action(async(o:Options&{preserveCurrent?:boolean})=>{
      const s=await service(o);const target=connection(o);
      if(o.preserveCurrent)emit(o,{event:'recovery-preserved',...await s.resolveRecovery({...target,preserveCurrent:true})});
      emit(o,await s.resume(target));
    });
}
