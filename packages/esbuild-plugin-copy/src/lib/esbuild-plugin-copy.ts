import type { Plugin } from 'esbuild';
import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import globby, { GlobbyOptions } from 'globby';

type MaybeArray<T> = T | T[];

// file/folder/globs
export interface AssetPair {
  /**
   * from path is resolved based on `cwd`
   */
  from: MaybeArray<string>;
  /**
   * to path is resolved based on `outdir` or `outfile` in your ESBuild options by default
   */
  to: MaybeArray<string>;
  /**
   * use Keep-Structure mode for current assets pair
   *
   * Keep-Structure mode will used for current assets
   * when one of the root-level keepStructure or asset-level keepSructure
   * is true
   *
   * @default false
   */
  keepStructure?: boolean;
}

export interface Options {
  /**
   * assets pair to copy
   * @default []
   */
  assets: MaybeArray<AssetPair>;
  /**
   * execute copy in `ESBuild.onEnd` hook(recommended)
   *
   * set to true if you want to execute in onStart hook
   * @default false
   */
  copyOnStart: boolean;
  /**
   * enable verbose logging
   *
   * outputs from-path and to-path finally passed to `fs.copyFileSync` method
   * @default false
   */
  verbose: boolean;
  /**
   * options passed to `globby` when we 're globbing for files to copy
   * @default {}
   */
  globbyOptions: GlobbyOptions;
  /**
   * only execute copy operation once
   *
   * useful when you're using ESBuild.build watching mode
   * @default false
   */
  once: boolean;
  /**
   * use `Keep-Structure` mode for all assets pairs
   *
   * @default false
   */
  keepStructure: boolean;

  /**
   * base path used to resolve relative `assets.to` path
   * by default this plugin use `outdir` or `outfile` in your ESBuild options
   * you can specify "cwd" or process.cwd() to resolve from current working directory,
   * also, you can specify somewhere else to resolve from.
   * @default "out"
   */
  resolveFrom: 'cwd' | 'out' | string;

  /**
   * use dry run mode to see what's happening.
   *
   * remember to keep `verbose` open to see the output.
   *
   * @default false
   */
  dryRun?: boolean;
}

function keepStructureCopyHandler(
  outDir: string,
  rawFromPath: string[],
  globbedFromPath: string,
  baseToPath: string,
  verbose = false,
  dryRun = false
) {
  // we keep structure only when input from path ends with /**/*(.ext)
  // for \/* only, we use simple merge copy handler
  // we only support /**/* now
  // and /**/*.js?

  for (const rawFrom of rawFromPath) {
    const { dir } = path.parse(rawFrom);

    // be default, when ends with /*, glob doesnot expand directories
    // avoid use override option `expandDirectories` and use `/*`
    if (!dir.endsWith('/**')) {
      verboseLog(
        `You're using ${chalk.white(
          'Keep-Structure'
        )} mode for the assets paire which its ${chalk.white(
          'from'
        )} path doesnot ends with ${chalk.white(
          '/**/*(.ext)'
        )}, fallback to ${chalk.white('Merge-Structure')} mode`,
        verbose
      );
      mergeCopyHandler(outDir, globbedFromPath, baseToPath, verbose);
    }

    const startFragment = dir.replace(`/**`, '');

    const preservedDirStructure = globbedFromPath.replace(startFragment, '');

    const sourcePath = path.resolve(globbedFromPath);

    const composedDistDirPath = path.resolve(
      outDir,
      baseToPath,
      preservedDirStructure.slice(1)
    );

    !dryRun && fs.ensureDirSync(path.dirname(composedDistDirPath));
    !dryRun && fs.copyFileSync(sourcePath, composedDistDirPath);

    verboseLog(
      `${dryRun ? chalk.white('[DryRun] ') : ''}File copied: ${chalk.white(
        sourcePath
      )} -> ${chalk.white(composedDistDirPath)}`,
      verbose
    );
  }
}

function mergeCopyHandler(
  outDir: string,
  from: string,
  to: string,
  verbose = false,
  dryRun = false
) {
  // absolute file path for each pair's from
  const sourcePath = path.resolve(from);

  const parsedFromPath = path.parse(from);
  const parsedToPath = path.parse(to);

  // if we specified file name in to path, we use its basename
  // or, we make the from path base as default
  const distBaseName = parsedToPath.ext.length
    ? parsedToPath.base
    : parsedFromPath.base;

  // if user specified file name in `to` path:
  // case: ./file.ext, the parsed.dir will be '.' we need to use empty dist dir: ''
  // case: ./dir/file.ext, the parsed.dir will be './dir' and we need to use './dir'

  const distDir = parsedToPath.dir === '.' ? '' : parsedToPath.dir;

  const distPath = path.resolve(outDir, distDir, distBaseName);

  !dryRun && fs.ensureDirSync(path.dirname(distPath));
  !dryRun && fs.copyFileSync(sourcePath, distPath);

  verboseLog(
    `${dryRun ? chalk.white('[DryRun] ') : ''}File copied: ${chalk.white(
      sourcePath
    )} -> ${chalk.white(distPath)}`,
    verbose
  );
}

function ensureArray<T>(item: MaybeArray<T>): Array<T> {
  return Array.isArray(item) ? item : [item];
}

function verboseLog(msg: string, verbose: boolean, lineBefore = false) {
  if (!verbose) {
    return;
  }
  console.log(chalk.blue(lineBefore ? '\ni' : 'i'), msg);
}

function formatAssets(assets: MaybeArray<AssetPair>) {
  return ensureArray(assets)
    .filter((asset) => asset.from && asset.to)
    .map(({ from, to, keepStructure = false }) => ({
      from: ensureArray(from),
      to: ensureArray(to),
      keepStructure,
    }));
}

const PLUGIN_EXECUTED_FLAG = 'esbuild_copy_executed';

export const copy = (options: Partial<Options> = {}): Plugin => {
  const {
    assets = [],
    copyOnStart = false,
    globbyOptions = {},
    verbose = false,
    once = false,
    keepStructure: globalKeepStructure = false,
    resolveFrom = 'out',
    dryRun = false,
  } = options;

  const formattedAssets = formatAssets(assets);

  const applyHook = copyOnStart ? 'onStart' : 'onEnd';

  return {
    name: 'plugin:copy',
    setup(build) {
      build[applyHook](async () => {
        if (once && process.env[PLUGIN_EXECUTED_FLAG] === 'true') {
          verboseLog(
            `Copy plugin skipped as option ${chalk.white('once')} set to true`,
            verbose
          );
          return;
        }

        if (!formattedAssets.length) {
          return;
        }

        let outDirResolve: string;

        if (resolveFrom === 'cwd') {
          outDirResolve = process.cwd();
        } else if (resolveFrom === 'out') {
          const outDir =
            build.initialOptions.outdir ??
            path.dirname(build.initialOptions.outfile!);

          if (!outDir) {
            verboseLog(
              chalk.red(
                `You should provide valid ${chalk.white(
                  'outdir'
                )} or ${chalk.white(
                  'outfile'
                )} for assets copy. received outdir:${
                  build.initialOptions.outdir
                }, received outfile:${build.initialOptions.outfile}`
              ),
              verbose
            );

            return;
          }

          outDirResolve = outDir;
        } else {
          outDirResolve = resolveFrom;
        }

        verboseLog(
          `Resolve assert pair to path from: ${path.resolve(outDirResolve)}`,
          verbose
        );

        for (const {
          from,
          to,
          keepStructure: pairKeepStructure,
        } of formattedAssets) {
          const pathsCopyFrom = await globby(from, {
            expandDirectories: false,
            onlyFiles: true,
            ...globbyOptions,
          });

          const keep = globalKeepStructure || pairKeepStructure;

          verboseLog(
            `Use ${chalk.white(
              keep ? 'Keep-Structure' : 'Merge-Structure'
            )} for current assets pair.`,
            verbose,
            true
          );

          const deduplicatedPaths = [...new Set(pathsCopyFrom)];

          if (!deduplicatedPaths.length) {
            verboseLog(
              `No files matched using current glob pattern: ${chalk.white(
                from
              )}, maybe you need to configure globby by ${chalk.white(
                'options.globbyOptions'
              )}?`,
              verbose
            );
          }

          for (const fromPath of deduplicatedPaths) {
            to.forEach((toPath) => {
              keep
                ? keepStructureCopyHandler(
                    outDirResolve,
                    from,
                    fromPath,
                    toPath,
                    verbose,
                    dryRun
                  )
                : mergeCopyHandler(
                    outDirResolve,
                    fromPath,
                    toPath,
                    verbose,
                    dryRun
                  );
            });
          }
          process.env[PLUGIN_EXECUTED_FLAG] = 'true';
        }
      });
    },
  };
};
