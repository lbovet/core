import { dirname, resolve as resolvePath } from 'path'
import Promise = require('any-promise')
import pick = require('object.pick')
import zipObject = require('zip-object')
import extend = require('xtend')
import {
  readJspmPackageJson,
  resolveByPackageJson,
  resolve,
  DependencyTree as JspmDependencyTree,
  DependencyBranch as JspmDependencyBranch
} from 'jspm-config'

import {
  DEFAULT_DEPENDENCY,
  Options,
  resolveError,
  mergeDependencies,
  maybeResolveTypeDependencyFrom,
  checkCircularDependency
} from './dependencies'
import { Dependency, DependencyTree, DependencyBranch } from '../interfaces'
import { readJson } from '../utils/fs'
import { CONFIG_FILE } from '../utils/config'
import { findUp } from '../utils/find'

interface JspmOptions extends Options {
  /**
   * Jspm relies on this tree to figure out the location of the files.
   * Need to pass this tree down the line.
   */
  tree: JspmDependencyTree
}

interface Metadata {
  name: any
  version: any
  main: any
  browser: any
  typings: any
  browserTypings: any
}

export function resolveDependencies(options: Options): Promise<DependencyTree> {
  options.isJspm = true
  return findUp(options.cwd, 'package.json')
    .then((packageJsonPath: string) => {
      const cwd = dirname(packageJsonPath)
      return readJspmPackageJson({ cwd })
        .then(pjson => {
          const branch = resolveByPackageJson(pjson, { cwd })
          const queue = [] as Promise<DependencyTree>[]
          for (let name in branch) {
            const tree = branch[name]
            const jspmOptions = extend(options, { tree })
            queue.push(resolveJspmDependency(name, `jspm:${name}`, jspmOptions))
          }

          return Promise.all(queue)
            .then(trees => {
              const dependencies: any = {}
              trees.forEach(t => {
                dependencies[t.name] = t
              })

              const tree: DependencyTree = extend(DEFAULT_DEPENDENCY, {
                name: pjson.name,
                version: pjson.version,
                main: pjson.main,
                browser: pjson.browser,
                typings: pjson.typings,
                browserTypings: pjson.browserTypings,
                src: packageJsonPath,
                dependencies
              })

              return tree
            })
        })
    })
    .catch(error => {
      return Promise.reject(error)
    })
}

/**
 * Resolve a dependency in Jspm.
 */
export function resolveDependency(dependency: Dependency, options: Options): Promise<DependencyTree> {
  options.isJspm = true

  const name = dependency.meta.name
  const { raw } = dependency
  return findUp(options.cwd, 'package.json')
    .then((packageJsonPath: string) => {
      const cwd = dirname(packageJsonPath)
      return resolve(name, { cwd })
    })
    .then(
    tree => {
      const jspmOptions = extend(options, { tree })
      return resolveJspmDependency(name, raw, jspmOptions)
    },
    error => {
      return Promise.reject(resolveError(raw, error, options))
    })
}

function resolveJspmDependency(
  name: string,
  raw: string,
  options: JspmOptions): Promise<DependencyTree> {
  const { parent, tree } = options
  const modulePath = tree.path
  const src = resolvePath(options.cwd, modulePath, 'package.json')

  checkCircularDependency(parent, src)

  options.emitter.emit('resolve', { name, modulePath, raw, parent })

  return readModuleMetaData(src)
    .then(meta => {
      const resultTree = extend(
        DEFAULT_DEPENDENCY, {
          name,
          src,
          raw,
          parent
        },
        meta)

      const dependencyOptions = extend(options, { parent: resultTree })
      options.emitter.emit('resolved', { name, modulePath, resultTree, raw, parent })
      const configPath = resolvePath(options.cwd, modulePath, CONFIG_FILE)
      return Promise
        .all([
          resolveDependencyMap(tree.map, dependencyOptions),
          maybeResolveTypeDependencyFrom(configPath, raw, options)
        ])
        .then(([dependencies, typedPackage]) => {
          resultTree.dependencies = dependencies
          return mergeDependencies(resultTree, typedPackage)
        })
    })
}

function readModuleMetaData(modulePackageJsonPath: string): Promise<Metadata> {
  return readJson(modulePackageJsonPath)
    .then(pjson => {
      return pick(pjson, [
        'name',
        'version',
        'main',
        'browser',
        'typings',
        'browserTypings'
      ])
    })
}

/**
 * Recursively resolve dependencies from a list and component path.
 */
function resolveDependencyMap(
  dependencies: JspmDependencyBranch = {},
  options: JspmOptions
): Promise<DependencyBranch> {
  const keys = Object.keys(dependencies)
  return Promise
    .all(keys.map(function (name) {
      const resolveOptions = extend(options, { dev: false, peer: false, global: false, tree: dependencies[name] })
      return resolveJspmDependency(name, `jspm:${name}`, resolveOptions)
    }))
    .then(results => {
      const result = zipObject(keys, results)
      return result
    })
}
