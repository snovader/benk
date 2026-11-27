// The builds that Node's `compareBuilds()` compares: modules that the
// command line names by their paths from the working directory, which it
// imports as files of their own, and the build that this process loads
// first, which a run of `--processes` takes from its environment.
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Build, BuildName } from '#source/core/types';
import { childRunValue, FIRST_BUILD } from './child-run.ts';

/**
 * The builds of the command line's modules, each by its file's URL, past
 * any symbolic link, as Node's loader names a module
 *
 * @throws {TypeError} If a module names a directory, or both name the same
 * file, which would compare a build with itself.
 * @throws {Error} If a module's file is missing.
 */
export async function resolveBuilds(
    modules: Readonly<Record<BuildName, string>>
): Promise<Record<BuildName, Build>> {
    const [base, head] = await Promise.all([
        resolveBuild(modules.base, '--base'),
        resolveBuild(modules.head, '--head')
    ]);
    if (base.url === head.url) {
        throw new TypeError(
            `Expected --base and --head to name two builds, but both are ${fileURLToPath(base.url)}`
        );
    }

    return { base, head };
}

/**
 * A build's module, by its file
 *
 * @throws {TypeError} If it's a directory.
 * @throws {Error} If it's missing.
 */
async function resolveBuild(module: string, option: string): Promise<Build> {
    const path = resolve(module);
    let file: string;
    try {
        file = await realpath(path);
    } catch (error) {
        throw new Error(`Expected ${option} to name a module, got ${path}`, {
            cause: error
        });
    }
    if ((await stat(file)).isDirectory()) {
        throw new TypeError(
            `Expected ${option} to name a module's file, got the directory ${file}: name the module that the build's package exports, as ${module}/dist/index.js`
        );
    }

    return { module, url: pathToFileURL(file).href };
}

/** Imports a build's module, as a module of its own */
export function loadBuild(build: Build): Promise<unknown> {
    return import(build.url);
}

/**
 * The build that this process loads first: what a run of `--processes`
 * was given, or base in the first process and the traced run
 */
export function firstBuildOfProcess(): BuildName {
    return childRunValue(FIRST_BUILD) === 'head' ? 'head' : 'base';
}
