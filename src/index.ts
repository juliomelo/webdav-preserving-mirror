import { v2 as webdav } from 'webdav-server';
import PreservingMirrorFileSystem from './PreservingMirrorFileSystem';
import MirrorRepository from './MirrorRepository';
import process from 'process';

if (process.argv.length != 4) {
    console.error('Syntax: wpm <source directory> <changes repository directory path>')
    process.exit(-1);
}

const mirrorPath = process.argv[2];
const changesPath = process.argv[3];

console.log('Mirror-Path:', mirrorPath);
console.log('Changes-Path:', changesPath);

const mirror = new MirrorRepository(mirrorPath, changesPath);

const server = new webdav.WebDAVServer({
    port: 1900
});


server.setFileSystemSync('/', new PreservingMirrorFileSystem(mirror));

server.afterRequest((arg, next) => {
    if (arg.response.statusCode >= 400) {
        let prefixo; 

        if ((arg.request as any).$ts) {
            const dif = new Date().getTime() - (arg.request as any).$ts;
            prefixo = `[${dif}ms] >>`;
        } else {
            prefixo = `[${new Date().toString()}] >>`;
        }

        console.log(prefixo, arg.request.method, arg.request.url, '>', arg.response.statusCode, arg.response.statusMessage);

        next();
    }
});

server.start(() => console.log('Ready!'));