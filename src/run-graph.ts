import chalk from 'chalk'

import { PkgJson, Dict } from './workspace'
import { ResultSpecialValues, Result, ProcResolution } from './enums'
import { CmdProcess } from './cmd-process'
import { minimatch } from 'minimatch'
import { fixPaths } from './fix-paths'
import { ConsoleFactory, SerializedConsole, DefaultConsole } from './console'
import { getChangedFilesForRoots } from 'jest-changed-files'
import { filterChangedPackages } from './filter-changed-packages'
import { expandRevDeps } from './rev-deps'

import throat from 'throat'

type PromiseFn<T> = () => Promise<T>
type PromiseFnRunner = <T>(f: PromiseFn<T>) => Promise<T>

let passThrough: PromiseFnRunner = f => f()

function intersection(s1: string[], s2: string[]) {
  return s1.filter(x => s2.includes(x))
}

function uniq(s: string[]) {
  return Array.from(new Set(s))
}

class Prefixer {
  constructor() {}
  private currentName = ''
  prefixer = (basePath: string, pkg: string, line: string) => {
    let l = ''
    if (this.currentName != pkg) l += chalk.bold((this.currentName = pkg)) + '\n'
    l += ' | ' + line // this.processFilePaths(basePath, line)
    return l
  }
}

export interface GraphOptions {
  bin: string
  fastExit: boolean
  collectLogs: boolean
  addPrefix: boolean
  rewritePaths: boolean
  mode: 'parallel' | 'serial' | 'stages'
  recursive: boolean
  doneCriteria: string | undefined
  changedSince: string | undefined
  revRecursive: boolean
  workspacePath: string
  exclude: string[]
  excludeMissing: boolean
  showReport: boolean
  if: string
  ifDependency: boolean
  concurrency: number | null
}

export class RunGraph {
  private procmap = new Map<string, Promise<ProcResolution>>()
  children: CmdProcess[]
  finishedAll!: Promise<CmdProcess[]>
  private jsonMap = new Map<string, PkgJson>()
  private runList = new Set<string>()
  private resultMap = new Map<string, Result>()
  private throat: PromiseFnRunner = passThrough
  private consoles: ConsoleFactory
  pathRewriter = (pkgPath: string, line: string) => fixPaths(this.opts.workspacePath, pkgPath, line)

  constructor(
    public pkgJsons: PkgJson[],
    public opts: GraphOptions,
    public pkgPaths: Dict<string>
  ) {
    this.checkResultsAndReport = this.checkResultsAndReport.bind(this)

    pkgJsons.forEach(j => this.jsonMap.set(j.name, j))
    this.children = []
    // serial always has a concurrency of 1
    if (this.opts.mode === 'serial') this.throat = throat(1)
    // max 16 proc unless otherwise specified
    else if (this.opts.mode === 'stages') this.throat = throat(opts.concurrency || 16)
    else if (opts.concurrency) this.throat = throat(opts.concurrency)

    if (opts.collectLogs) this.consoles = new SerializedConsole(console)
    else this.consoles = new DefaultConsole()
  }

  private globalPrefixer = new Prefixer().prefixer
  /**
   * Creates or provides the global prefixer. This depends on the collect-logs flag which describes whether the processes should use a shared prefixer.
   */
  private createOrProvidePrefixerForProcess = () => {
    if (this.opts.addPrefix) {
      if (this.opts.collectLogs) {
        return new Prefixer().prefixer
      } else {
        return this.globalPrefixer
      }
    }
    return undefined
  }

  closeAll() {
    console.log('Stopping', this.children.length, 'active children')
    this.children.forEach(ch => ch.stop())
  }

  private lookupOrRun(cmd: string[], pkg: string): Promise<ProcResolution> {
    let proc = this.procmap.get(pkg)
    if (proc == null) {
      proc = Promise.resolve().then(() => this.runOne(cmd, pkg))
      this.procmap.set(pkg, proc)
      return proc
    }
    return proc
  }

  private allDeps(pkg: PkgJson) {
    let findMyDeps = uniq(
      Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}))
    ).filter(d => this.jsonMap.has(d) && (this.opts.recursive || this.runList.has(d)))
    return findMyDeps
  }

  detectCycles() {
    let topLevelPkgs: { [name: string]: any } = {}
    for (let key of this.jsonMap.keys()) {
      topLevelPkgs[key] = '*'
    }
    let top = { name: '$', dependencies: topLevelPkgs }
    let self = this
    function deepCycle(json: PkgJson, pathLookup: string[]): string[] {
      let newPathLookup = pathLookup.concat([json.name])
      let index = pathLookup.indexOf(json.name)
      if (index >= 0) {
        return newPathLookup.slice(index)
      }
      let currentDeps = Object.keys(json.dependencies || {}).concat(
        Object.keys(json.devDependencies || {})
      )
      for (let name of currentDeps) {
        let d = self.jsonMap.get(name)
        if (!d) continue
        let res = deepCycle(d, newPathLookup)
        if (res.length) return res
      }
      return []
    }
    let res = deepCycle(top, [])
    return res
  }

  private makeCmd(cmd: string[]) {
    return [this.opts.bin].concat(cmd)
  }

  private runCondition(cmd: string, pkg: string) {
    let cmdLine = this.makeCmd(cmd.split(' '))
    let c = this.consoles.create()
    const child = new CmdProcess(c, cmdLine, pkg, {
      rejectOnNonZeroExit: false,
      silent: true,
      collectLogs: this.opts.collectLogs,
      prefixer: this.createOrProvidePrefixerForProcess(),
      doneCriteria: this.opts.doneCriteria,
      path: this.pkgPaths[pkg]
    })
    child.finished.then(() => this.consoles.done(c))
    let rres = child.exitCode.then(code => code === 0)
    child.start()
    return rres
  }

  private runOne(cmdArray: string[], pkg: string): Promise<ProcResolution> {
    let p = this.jsonMap.get(pkg)
    if (p == null) throw new Error('Unknown package: ' + pkg)
    let myDeps = Promise.all(this.allDeps(p).map(d => this.lookupOrRun(cmdArray, d)))

    return myDeps.then(depsStatuses => {
      this.resultMap.set(pkg, ResultSpecialValues.Pending)

      if (this.opts.exclude.indexOf(pkg) >= 0) {
        console.log(chalk.bold(pkg), 'in exclude list, skipping')
        this.resultMap.set(pkg, ResultSpecialValues.Excluded)
        return Promise.resolve(ProcResolution.Excluded)
      }
      if (this.opts.excludeMissing && (!p || !p.scripts || !p.scripts[cmdArray[0]])) {
        console.log(chalk.bold(pkg), 'has no', cmdArray[0], 'script, skipping missing')
        this.resultMap.set(pkg, ResultSpecialValues.MissingScript)
        return Promise.resolve(ProcResolution.Missing)
      }

      let ifCondtition = Promise.resolve(true)

      if (
        this.opts.if &&
        (!this.opts.ifDependency || !depsStatuses.find(ds => ds === ProcResolution.Normal))
      ) {
        ifCondtition = this.runCondition(this.opts.if, pkg)
      }

      let child = ifCondtition.then(shouldExecute => {
        if (!shouldExecute) {
          this.resultMap.set(pkg, ResultSpecialValues.Excluded)
          return Promise.resolve({
            status: ProcResolution.Excluded,
            process: null as null | CmdProcess
          })
        }

        let cmdLine = this.makeCmd(cmdArray)
        let c = this.consoles.create()
        const child = new CmdProcess(c, cmdLine, pkg, {
          rejectOnNonZeroExit: this.opts.fastExit,
          collectLogs: this.opts.collectLogs,
          prefixer: this.createOrProvidePrefixerForProcess(),
          pathRewriter: this.opts.rewritePaths ? this.pathRewriter : undefined,
          doneCriteria: this.opts.doneCriteria,
          path: this.pkgPaths[pkg]
        })
        child.finished.then(() => this.consoles.done(c))
        child.exitCode.then(code => this.resultMap.set(pkg, code))
        this.children.push(child)
        return Promise.resolve({ status: ProcResolution.Normal, process: child })
      })

      return child.then(ch => {
        let processRun = this.throat(() => {
          if (ch.process) {
            ch.process.start()
            return ch.process.finished
          }
          return Promise.resolve()
        })
        if (this.opts.mode === 'parallel' || !ch.process) return ch.status
        else return processRun.then(() => ProcResolution.Normal)
      })
    })
  }

  private checkResultsAndReport(cmdLine: string[], pkgs: string[]) {
    let cmd = cmdLine.join(' ')
    const pkgsInError: string[] = []
    const pkgsSuccessful: string[] = []
    const pkgsPending: string[] = []
    const pkgsSkipped: string[] = []
    const pkgsMissingScript: string[] = []

    this.resultMap.forEach((result, pkg) => {
      switch (result) {
        case ResultSpecialValues.Excluded:
          pkgsSkipped.push(pkg)
          break

        case ResultSpecialValues.MissingScript:
          pkgsMissingScript.push(pkg)
          break

        case ResultSpecialValues.Pending:
          pkgsPending.push(pkg)
          break

        case 0:
          pkgsSuccessful.push(pkg)
          break

        default:
          pkgsInError.push(pkg)
          break
      }
    })

    if (this.opts.showReport) {
      const formatPkgs = (pgks: string[]): string => pgks.join(', ')
      const pkgsNotStarted = pkgs.filter(pkg => !this.resultMap.has(pkg))

      console.log(chalk.bold('\nReport:'))

      if (pkgsInError.length)
        console.log(
          chalk.red(
            `  ${pkgsInError.length} packages finished \`${cmd}\` with error: ${formatPkgs(
              pkgsInError
            )}`
          )
        )
      if (pkgsSuccessful.length)
        console.log(
          chalk.green(
            `  ${pkgsSuccessful.length} packages finished \`${cmd}\` successfully: ${formatPkgs(
              pkgsSuccessful
            )}`
          )
        )
      if (pkgsPending.length)
        console.log(
          chalk.white(
            `  ${pkgsPending.length} packages have been cancelled running \`${cmd}\`: ${formatPkgs(
              pkgsPending
            )}`
          )
        )
      if (pkgsNotStarted.length)
        console.log(
          chalk.white(
            `  ${pkgsNotStarted.length} packages have not started running \`${cmd}\`: ${formatPkgs(
              pkgsNotStarted
            )}`
          )
        )
      if (pkgsMissingScript.length)
        console.log(
          chalk.gray(
            `  ${pkgsMissingScript.length} packages are missing script \`${cmd}\`: ${formatPkgs(
              pkgsMissingScript
            )}`
          )
        )
      if (pkgsSkipped.length)
        console.log(
          chalk.gray(
            `  ${pkgsSkipped.length} packages have been skipped: ${formatPkgs(pkgsSkipped)}`
          )
        )

      console.log()
    }

    return pkgsInError.length > 0
  }

  filterByGlobs(pkgs: string[], globs: string[]) {
    if (globs && globs.length > 0) {
      pkgs = pkgs.filter(name => globs.some(glob => minimatch(name, glob)))
    }

    return Promise.resolve(pkgs)
  }

  filterByChangedFiles(pkgs: string[]) {
    // if changedSince is defined, filter the packages to contain only changed packages (according to git)
    if (this.opts.changedSince) {
      return getChangedFilesForRoots([this.opts.workspacePath], {
        changedSince: this.opts.changedSince
      })
        .then(data => {
          if (!data.repos || (data.repos.git.size === 0 && data.repos.hg.size === 0)) {
            throw new Error(
              "The workspace is not a git/hg repo and it cannot work with 'changedSince'"
            )
          }

          return filterChangedPackages(
            [...data.changedFiles],
            this.pkgPaths,
            this.opts.workspacePath
          )
        })
        .then(changedPackages => intersection(pkgs, changedPackages))
    }

    return Promise.resolve(pkgs)
  }

  addRevDeps = (pkgs: string[]) => {
    if (this.opts.revRecursive) {
      return expandRevDeps(pkgs, this.pkgJsons)
    } else {
      return pkgs
    }
  }

  async run(cmd: string[], globs: string[] = ['**/*']) {
    let pkgs: string[] = this.pkgJsons.map(p => p.name)

    pkgs = await this.filterByGlobs(pkgs, globs).then(pkgs =>
      this.filterByChangedFiles(pkgs).then(pkgs => this.addRevDeps(pkgs))
    )

    this.runList = new Set(pkgs)
    return (
      Promise.all(pkgs.map(pkg => this.lookupOrRun(cmd, pkg)))
        // Wait for any of them to error
        .then(() => Promise.all(this.children.map(c => c.exitError)))
        // If any of them do, and fastExit is enabled, stop every other
        .catch(_err => this.opts.fastExit && this.closeAll())
        // Wait for the all the processes to finish
        .then(() => Promise.all(this.children.map(c => c.result)))
        // Generate report
        .then(() => this.checkResultsAndReport(cmd, pkgs))
    )
  }
}
