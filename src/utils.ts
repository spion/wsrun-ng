export interface Defer<T> {
  promise: Promise<T>
  resolve: (thenableOrResult?: T | PromiseLike<T> | undefined) => void
  reject: (error?: any) => void
}

export function defer<T>() {
  let d: Defer<T>
  let promise = new Promise<T>((resolve, reject) => {
    d = { resolve, reject } as any
  })
  d!.promise = promise
  return d!
}
