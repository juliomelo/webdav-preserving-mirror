import { stat, unlink, rmdir, copyFile, readdir, mkdir, readdirSync, mkdirSync, readFileSync, accessSync, openSync, write, existsSync } from "fs";
import * as path from "path";

/**
 * A read-write mirror repository, that mirror a read-only filesystem.
 */
export default class MirrorRepository {
    private readonly local = new Set<string>();
    private readonly deletedFileDescriptor: number;
    private readonly mirroring : {
        [path: string]: Promise<never>
    } = {};

    constructor(public readonly remotePathMapping: string, public readonly localPathMapping: string, public readonly dirSeparator: string = path.sep) {
        mkDirByPathSync(this.getLocalPath('/'));

        let entries = readdirSync(this.getLocalPath('/'));

        while (entries.length > 0) {
            let entry = entries.pop()!;

            try {
                const children = readdirSync(this.getLocalPath(entry)).map(s => `${entry}/${s}`);
                entries = entries.concat(children);
            } catch (err) {
                if (err.code === 'ENOTDIR') {
                    this.local.add('/' + entry);
                } else {
                    throw err;
                }
            }
        }

        console.info(`There is ${this.local.size} local files.`);

        let deleted: string[];

        try {
            deleted = readFileSync(`${localPathMapping}${dirSeparator}deleted`).toString().split('\n');
        } catch (e) {
            deleted = [];
        }

        this.deletedFileDescriptor = openSync(`${localPathMapping}${dirSeparator}deleted`, 'a')

        deleted.map(s => s.trim())
            .filter(s => s.length > 0)
            .forEach(entry => this.local.add(entry));

        console.info(`There is ${this.local.size} local entries.`);            
    }

    public getReadOnlyPath(remotePath: string): string {
        const localPath = this.getLocalPath(remotePath);
        
        if (this.local.has(remotePath) || existsSync(localPath)) {
            return localPath;
        } else {
            return this.resolvePath(this.remotePathMapping, remotePath);
        }
    }

    public async getReadWritePath(remotePath: string): Promise<string> {
        const localPath = this.getLocalPath(remotePath);

        if (this.local.has(remotePath)) {
            return localPath;
        }

        try {
            await this.mirror(remotePath, localPath);
        } catch (err) {
            if (err.code == 'ENOENT') {
                this.local.add(remotePath);
            } else {
                console.error('Cannot get read-write path!', remotePath, err.code);
                throw err;
            }
        }

        return localPath;
    }

    public removePath(remotePath: string): Promise<never> {
        return new Promise((_resolve, reject) => {
            const localPath = this.getLocalPath(remotePath);
            const resolve = () => this.registerLocal(remotePath).then(_resolve, reject);

            stat(localPath, (err, stats) => {
                if (!err) {
                    // So let's delete locally.
                    if (stats.isFile() || stats.isSymbolicLink()) {
                        unlink(localPath, err => !err ? resolve() : reject(err));
                    } else {
                        rmdir(localPath, err => {
                            if (!err) {
                                resolve();
                            } else {
                                reject(err);
                            }
                        });
                    }
                } else if (err.code === 'ENOENT') {
                    // TODO: Check if it exists on remote. 
                    // WARNING: This could be reached by a move operation (that call this method to remove after rename)!
                    resolve();
                } else {
                    reject(err);
                }
            });
        });
    }

    public async readDir(remotePath: string): Promise<string[]> {
        const getFiles = (path: string) => new Promise<string[]>((resolve, reject) => {
            readdir(path, (err, files) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(files);
                }
            });
        });

        let remoteENOENT = false, localENOENT = false;
        const basedir = remotePath.endsWith('/') ? remotePath : remotePath + '/';
        const remote = getFiles(this.resolvePath(this.remotePathMapping, remotePath))
            .then(remoteFiles => remoteFiles.filter(file => {
                if (this.local.has(basedir + file)) {
                    return false;
                }

                try {
                    accessSync(this.resolvePath(this.remotePathMapping, remotePath, file));
                } catch (err) {
                    return false;
                }

                return true;
            }), err => {
                remoteENOENT = err.code === 'ENOENT';
                return remoteENOENT ? [] as string[] : Promise.reject<string[]>(err);
            });
        const local = getFiles(this.getLocalPath(remotePath)).catch(err => {
            localENOENT = err.code === 'ENOENT';

            return localENOENT ? [] : Promise.reject<string[]>(err);
        });

        const files = await Promise.all([remote, local]);

        if (remoteENOENT && localENOENT) {
            throw new Error('ENOENT');
        }

        return files.reduce((a, b) => a.concat(b));
    }

    private registerLocal(remotePath: string, onlyMemory: boolean = false): Promise<never> {
        this.local.add(remotePath);

        return new Promise((resolve, reject) => {
            if (onlyMemory) {
                resolve();
            } else {
                write(this.deletedFileDescriptor, `${remotePath}\n`, (err, len, buf) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }
        });
    }

    private mirror(remotePath: string, localPath: string): Promise<never> {
        if (this.mirroring[localPath]) {
            return this.mirroring[localPath];
        }

        const promise: Promise<never> = new Promise((resolve, reject) => {
            try {
                mkDirByPathSync(path.dirname(localPath));
            } catch (err) {
                delete this.mirroring[localPath];
                reject(err);
            }

            console.info('Mirroring', remotePath);
            
            copyFile(this.resolvePath(this.remotePathMapping, remotePath), localPath, err => {
                delete this.mirroring[localPath];
                if (!err) {
                    this.registerLocal(remotePath, true).then(resolve, reject);
                } else if (err.code === 'ENOTDIR') {
                    resolve(this.mirrorDir(remotePath, localPath));
                } else {
                    reject(err);
                }
            });
        });

        this.mirroring[localPath] = promise;

        return promise;
    }

    private mirrorDir(remotePath: string, localPath: string): Promise<never> {
        return new Promise((resolve, reject) => {
            readdir(this.resolvePath(this.remotePathMapping, remotePath), (err, files) => {
                if (err) {
                    console.error('Failed to mirror directory', err.code, remotePath, localPath);
                    reject(err);
                } else {
                    mkdir(localPath, err => {
                        if (err) {
                            console.error('Failed to create local directory', err.code, localPath);
                            reject(err);
                        } else {
                            const promises = files.map(file => this.mirror(`${remotePath}/${file}`, this.resolvePath(localPath, file)));
                            Promise.all(promises).then(() => this.registerLocal(remotePath).then(resolve, reject), reject);
                        }
                    });
                }
            });
        });
    }

    private resolvePath(...paths: string[]) {
        return paths.reduce((a, b) => {
            if (b.startsWith('..')) {
                throw new Error('Path cannot backward.');
            }

            if (!a.endsWith(this.dirSeparator)) {
                return b.startsWith(this.dirSeparator) ? a + b : `${a}${this.dirSeparator}${b}`;
            } else {
                return !b.startsWith(this.dirSeparator) ? a + b : a + b.substring(1);
            }
        });
    }

    private getLocalPath(remotePath: string): string {
        return this.resolvePath(this.localPathMapping, 'mirror', remotePath);
    }
}

// https://stackoverflow.com/questions/31645738/how-to-create-full-path-with-nodes-fs-mkdirsync
function mkDirByPathSync(targetDir: string, { isRelativeToScript = false } = {}) {
    const sep = path.sep;
    const initDir = path.isAbsolute(targetDir) ? sep : '';
    const baseDir = isRelativeToScript ? __dirname : '.';

    return targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = path.resolve(baseDir, parentDir, childDir);
        try {
            mkdirSync(curDir);
        } catch (err) {
            if (err.code === 'EEXIST') { // curDir already exists!
                return curDir;
            }

            // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
            if (err.code === 'ENOENT') { // Throw the original parentDir error on curDir `ENOENT` failure.
                throw new Error(`EACCES: permission denied, mkdir '${parentDir}'`);
            }

            const caughtErr = ['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) > -1;
            if (!caughtErr || caughtErr && curDir === path.resolve(targetDir)) {
                throw err; // Throw if it's just the last created dir.
            }
        }

        return curDir;
    }, initDir);
}