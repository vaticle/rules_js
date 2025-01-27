import { readWorkRequestSize, writeWorkResponseSize } from './size'
import { blaze } from './worker_protocol'
import { Writable } from 'stream'

export type WorkRequest = Omit<
    ReturnType<typeof blaze.worker.WorkRequest.prototype.toObject>,
    'cancel'
> & { signal: AbortSignal; output: Writable }

export type ImplementationFunc = (request: WorkRequest) => Promise<number>

export async function enterWorkerLoop(implementation: ImplementationFunc) {
    const abortionMap = new Map<number, AbortController>()

    let prev: Buffer = Buffer.alloc(0)

    for await (const buffer of process.stdin) {
        let chunk: Buffer = Buffer.concat([prev, buffer])
        let current: Buffer

        const size = readWorkRequestSize(chunk)

        if (size.size <= chunk.length + size.headerSize) {
            chunk = chunk.slice(size.headerSize)
            current = chunk.slice(0, size.size)
            prev = chunk.slice(size.size)
        } else {
            prev = chunk
            continue
        }

        const request = blaze.worker.WorkRequest.deserialize(current!)

        if (request.cancel) {
            abortionMap.get(request.request_id)?.abort()
            continue
        }

        const abortController = new AbortController()
        abortionMap.set(request.request_id, abortController)

        const response = new blaze.worker.WorkResponse({
            request_id: request.request_id,
        })

        const outputChunks = new Array()
        const outputStream = new Writable({
            write: (chunk, encoding, callback) => {
                outputChunks.push(Buffer.from(chunk, encoding))
                callback?.(undefined)
            },
            defaultEncoding: 'utf-8',
        })

        implementation({
            arguments: request.arguments,
            inputs: request.inputs,
            request_id: request.request_id,
            verbosity: request.verbosity,
            sandbox_dir: request.sandbox_dir,
            signal: abortController.signal,
            output: outputStream,
        })
            .then((exitCode) => {
                response.exit_code = exitCode
            })
            .catch((reason) => {
                response.exit_code = 1
                if ('stack' in reason) {
                    outputStream.write(String(reason.stack))
                } else {
                    outputStream.write(String(reason))
                }
            })
            .finally(() => {
                abortionMap.delete(request.request_id)
                outputStream.end()

                response.was_cancelled = abortController.signal.aborted
                response.output = Buffer.concat(outputChunks).toString('utf-8')

                const responseBytes = response.serialize()
                const responseSizeBytes = writeWorkResponseSize(
                    responseBytes.byteLength
                )
                process.stdout.write(
                    Buffer.concat([responseSizeBytes, responseBytes])
                )
            })
    }
}

export function isPersistentWorker(args: string[]): boolean {
    return args.indexOf('--persistent_worker') !== -1
}
