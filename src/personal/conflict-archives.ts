import { posix } from 'node:path';
/** Exact Both archive suffix, with an optional original final extension. */
export function conflictOriginalPath(path: string): string | undefined {
 const original = path.replace(/\.conflict-\d{8}-\d{6}-local(\.[^./]+)?$/, '$1');
 return original === path ? undefined : original;
}
/** Full payload identity wins: legal IDs can themselves look like archive names. */
export function isBoundConflictArchive(path: string, payloadId: string): boolean {
 const name=posix.basename(path,'.json');
 if(name===payloadId)return false;
 let original=conflictOriginalPath(path);
 while(original!==undefined){
  if(posix.basename(original,'.json')===payloadId)return true;
  original=conflictOriginalPath(original);
 }
 return false;
}
export function bindsPersonalRecord(path:string,payloadId:string):boolean {
 return posix.basename(path,'.json')===payloadId || isBoundConflictArchive(path,payloadId);
}

/** Deepest syntactically recognized ancestor; identity binding still uses payload. */
export function conflictBasePath(path:string):string {
 let current=path, original=conflictOriginalPath(current);
 while(original!==undefined){current=original;original=conflictOriginalPath(current);}
 return current;
}
