import { FileSystem, RequestContext, Path, CreateInfo, SimpleCallback, ReturnCallback, DeleteInfo, OpenWriteStreamInfo, OpenReadStreamInfo, MoveInfo, SizeInfo, ReadDirInfo, CreationDateInfo, LastModifiedDateInfo, ResourceType, IPropertyManager, Errors, ILockManager, PhysicalFileSystemResource, LockManagerInfo, PropertyManagerInfo, LocalPropertyManager, Return2Callback, PropertyAttributes, ResourcePropertyValue } from "webdav-server/lib/index.v2";
import { Writable, Readable } from "stream";
import MirrorRepository from "./MirrorRepository";
import { stat, open, createReadStream, mkdir, close, createWriteStream, rename, access, Stats } from "fs";
import { O_CREAT, R_OK, W_OK } from "constants";

/**
 * Exposes a read-write mirror file system, but preserving original
 * file system. No change is made to the original file system.
 * All changes are written in a overlay folder.
 * 
 * @author Júlio César e Melo
 */
export default class PreservingMirrorFileSystem extends FileSystem {
    private readonly resources: {
        [path: string]: PhysicalFileSystemResource
    }

    constructor(private repository: MirrorRepository, resources?: { [path: string]: PhysicalFileSystemResource }) {
        super({
            uid() {
                return 'PreservingMirroFileSystem-1.0.0';
            },
            serialize(fs: PreservingMirrorFileSystem, callback: ReturnCallback<any>): void {
                const repo = fs.repository;

                callback(undefined, {
                    remote: repo.remotePathMapping,
                    local: repo.localPathMapping,
                    dirSeparator: repo.dirSeparator,
                    resources: fs.resources
                });
            },
            unserialize(serializedData: any, callback: ReturnCallback<FileSystem>): void {
                const fs = new PreservingMirrorFileSystem(new MirrorRepository(serializedData.remote, serializedData.local, serializedData.dirSeparator), serializedData.resources);
                callback(undefined, fs);
            }
        });

        this.resources = resources || {
            '/': new PhysicalFileSystemResource()
        };
    }

    protected _fastExistCheck(ctx: RequestContext, path: Path, callback: (exists: boolean) => void): void {
        access(this.repository.getReadOnlyPath(path.toString(false)), err => {
            if (err) {
                callback(false);
            } else {
                callback(true);
            }
        });
    }

    protected _create(path: Path, ctx: CreateInfo, _callback: SimpleCallback): void {
        this.repository.getReadWritePath(path.toString()).then(realPath => {
            const callback = (e: any) => {
                if (!e)
                    this.resources[path.toString()] = new PhysicalFileSystemResource();
                else if (e.code === 'EEXIST') {
                    e = Errors.ResourceAlreadyExists;
                }

                _callback(e);
            }

            if (ctx.type.isDirectory)
                mkdir(realPath, callback);
            else {
                open(realPath, O_CREAT, (e, fd) => {
                    if (e)
                        return callback(e);
                    close(fd, callback);
                });
            }
        }, err => _callback(err));
    }

    // protected _etag?(path : Path, ctx : ETagInfo, callback : ReturnCallback<string>) : void {}

    protected _delete(path: Path, ctx: DeleteInfo, _callback: SimpleCallback): void {
        const callback = (e: any) => {
            if (!e)
                delete this.resources[path.toString()];
            _callback(e);
        }

        this.type(ctx.context, path, (e, type) => {
            if (e)
                return callback(Errors.ResourceNotFound);

            if (type!.isDirectory) {
                if (ctx.depth === 0) {
                    this.repository.removePath(path.toString()).then(() => _callback(undefined), err => callback(err));
                }

                this.readDir(ctx.context, path, (e, files) => {
                    if (e) {
                        callback(e);
                    } else {
                        let nb = files!.length + 1;
                        const done = (e?: Error) => {
                            if (nb < 0)
                                return;

                            if (e) {
                                nb = -1;
                                return callback(e);
                            }

                            if (--nb === 0) {
                                this.repository.removePath(path.toString()).then(() => callback(undefined), err => callback(err));
                            }
                        }

                        files!.forEach((file) => this.delete(ctx.context, path.getChildPath(file), ctx.depth === -1 ? -1 : ctx.depth - 1, done));
                        done();
                    }
                })
            }
            else {
                this.repository.removePath(path.toString()).then(() => callback(undefined), err => callback(err));
            }
        })
    }

    protected _openWriteStream(path: Path, ctx: OpenWriteStreamInfo, callback: ReturnCallback<Writable>): void {
        this.repository.getReadWritePath(path.toString()).then(realPath => {
            open(realPath, 'w+', (e, fd) => {
                if (e) {
                    return callback(Errors.ResourceNotFound);
                }

                callback(undefined, createWriteStream(realPath, { fd }));
            });
        }, err => callback(err));
    }

    protected _openReadStream(path: Path, ctx: OpenReadStreamInfo, callback: ReturnCallback<Readable>): void {
        const realPath = this.repository.getReadOnlyPath(path.toString());

        open(realPath, 'r', (e, fd) => {
            if (e)
                return callback(Errors.ResourceNotFound);

            callback(undefined, createReadStream(realPath, { fd }));
        });
    }

    protected _move(pathFrom: Path, pathTo: Path, ctx: MoveInfo, callback: ReturnCallback<boolean>): void {
        const paths = Promise.all<string>([
            this.repository.getReadWritePath(pathFrom.toString()),
            this.repository.getReadWritePath(pathTo.toString())
        ]);

        paths.then(([realPathFrom, realPathTo]) => {
            const localRename = (overwritten: boolean) => {
                rename(realPathFrom, realPathTo, (e) => {
                    if (e)
                        return callback(e);

                    this.resources[realPathTo] = this.resources[realPathFrom];
                    delete this.resources[realPathFrom];
                    this.repository.removePath(pathFrom.toString());
                    callback(undefined, overwritten);
                });
            };

            access(realPathTo, (e) => {
                if (e) { // destination doesn't exist
                    localRename(false);
                }
                else { // destination exists
                    if (!ctx.overwrite)
                        return callback(Errors.ResourceAlreadyExists);

                    this.delete(ctx.context, pathTo, (e) => {
                        if (e)
                            return callback(e);
                        localRename(true);
                    });
                }
            })
        }, err => callback(err));
    }

    // protected _copy?(pathFrom : Path, pathTo : Path, ctx : CopyInfo, callback : ReturnCallback<boolean>) : void {}
    // protected _rename?(pathFrom : Path, newName : string, ctx : RenameInfo, callback : ReturnCallback<boolean>) : void {}
    // protected _mimeType?(path : Path, ctx : MimeTypeInfo, callback : ReturnCallback<string>) : void {}

    protected _size(path: Path, ctx: SizeInfo, callback: ReturnCallback<number>): void {
        this.getStatProperty(path, ctx, 'size', callback);
    }

    // protected _availableLocks?(path : Path, ctx : AvailableLocksInfo, callback : ReturnCallback<LockKind[]>) : void {}
    protected _readDir(path: Path, ctx: ReadDirInfo, callback: ReturnCallback<string[] | Path[]>): void {
        this.repository.readDir(path.toString()).then(files => {
            callback(undefined, files)
        }, err => {
            console.error('Cannot read directory!', path.toString(), err);

            if (err.code === 'ENOENT' || err.message === 'ENOENT') {
                callback(Errors.ResourceNotFound);
            } else {
                callback(err);
            }
        });
    }

    protected _creationDate(path: Path, ctx: CreationDateInfo, callback: ReturnCallback<number>): void {
        this.getStatDateProperty(path, ctx, 'birthtime', callback);
    }

    protected getStatProperty(path: Path, ctx: any, propertyName: string, callback: ReturnCallback<any>): void {
        const realPath = this.repository.getReadOnlyPath(path.toString());

        this.stat(realPath, ctx).then(stat => {
            if (propertyName === 'mode') {
                let mode = stat.mode;

                // Overwrite write mode
                if (mode & R_OK) {
                    mode |= W_OK;
                }

                callback(undefined, mode)
            } else {
                callback(undefined, (stat as any)[propertyName]);
            }
        }, err => callback(Errors.ResourceNotFound));
    }

    protected getStatDateProperty(path: Path, ctx: any, propertyName: string, callback: ReturnCallback<number>): void {
        this.getStatProperty(path, ctx, propertyName, (e, value) => callback(e, value ? (value as Date).valueOf() : value));
    }

    protected _lastModifiedDate(path: Path, ctx: LastModifiedDateInfo, callback: ReturnCallback<number>): void {
        this.getStatDateProperty(path, ctx, 'mtime', callback);
    }

    // protected _displayName?(path : Path, ctx : DisplayNameInfo, callback : ReturnCallback<string>) : void {}
    //    protected _privilegeManager?(path : Path, info : PrivilegeManagerInfo, callback : ReturnCallback<PrivilegeManager>)

    /**
     * Get a property of an existing resource (object property, not WebDAV property). If the resource doesn't exist, it is created.
     * 
     * (Copied from PhysicalFileSystem.ts)
     * 
     * @param path Path of the resource
     * @param ctx Context of the method
     * @param propertyName Name of the property to get from the resource
     * @param callback Callback returning the property object of the resource
     */
    protected getPropertyFromResource(path: Path, ctx: any, propertyName: string, _callback: ReturnCallback<any>): void {
        let resource = this.resources[path.toString()];
        const callback = () => _callback(undefined, (resource as any)[propertyName]);

        if (resource) {
            callback();
        } else {
            this.stat(this.repository.getReadOnlyPath(path.toString()), ctx).then(stats => {
                resource = new PhysicalFileSystemResource();

                if (stats.mode & 0o111) {
                    // NÃO ESTÁ FUNCIONANDO
                    resource.props.setProperty("http://apache.org/dav/props/executable",
                        '', {
                            xmlns: "http://apache.org/dav/props/"
                        },
                        () => {
                            this.resources[path.toString()] = resource;
                            callback();
                        });
                } else {
                    this.resources[path.toString()] = resource;
                    callback();
                }
            }, err => _callback(err));
        }
    }

    protected _lockManager(path: Path, ctx: LockManagerInfo, callback: ReturnCallback<ILockManager>): void {
        this.getPropertyFromResource(path, ctx, 'locks', callback);
    }

    protected _propertyManager(path: Path, ctx: PropertyManagerInfo, callback: ReturnCallback<IPropertyManager>): void {
        this.getPropertyFromResource(path, ctx, 'props', callback);
    }

    protected _type(path: import("webdav-server/lib/index.v2").Path, ctx: import("webdav-server/lib/index.v2").TypeInfo, callback: import("webdav-server/lib/index.v2").ReturnCallback<import("webdav-server/lib/index.v2").ResourceType>): void {
        const localPath = this.repository.getReadOnlyPath(path.toString());

        this.stat(localPath, ctx).then(stats => {
            if (stats.isDirectory()) {
                callback(undefined, ResourceType.Directory);
            } else {
                callback(undefined, ResourceType.File);
            }
        }, err => callback(new Error(err.message)));
    }

    protected async stat(localPath: string, ctx: any): Promise<Stats> {
        let stats: WPMStats = ctx.$wpmStats;

        if (!stats) {
            stats = {};
            ctx.$wpmStats = {};
        }

        let result = stats[localPath];

        if (!result) {
            return new Promise((resolve, reject) => {
                stat(localPath, (err, data) => {
                    if (err) {
                        if (err.code === 'ENOENT') {
                            reject(Errors.ResourceNotFound);
                        } else {
                            console.error('Cannot stat local path.', localPath, err, err.stack);
                            reject(err);
                        }
                    } else {
                        stats[localPath] = data;
                        resolve(data);
                    }
                });
            });
        } else {
            return result;
        }
    }
}

type WPMStats = { [localPath: string]: Stats };

class PMFSPropertyManager extends LocalPropertyManager {
    getProperty(name: string, callback: Return2Callback<ResourcePropertyValue, PropertyAttributes>): void {

    }
}