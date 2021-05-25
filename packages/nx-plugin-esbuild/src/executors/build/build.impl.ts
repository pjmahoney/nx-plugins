import { ExecutorContext } from '@nrwl/devkit';
import { BuildOptions } from 'esbuild';
import {
  TscRunnerOptions,
  RunnerSubcriber,
  ExecutorResponse,
} from './lib/types';
import { ESBuildExecutorSchema } from './schema';

import { bufferUntil, ensureProjectConfig } from 'nx-plugin-devkit';

import { zip, Observable, from, of, merge } from 'rxjs';
import {
  map,
  tap,
  mapTo,
  switchMap,
  switchMapTo,
  startWith,
  catchError,
} from 'rxjs/operators';
import { eachValueFrom } from 'rxjs-for-await';
import dayjs from 'dayjs';
import path from 'path';

import { runESBuild } from './lib/esbuild-runner';
import { runTSC } from './lib/tsc-runner';
import { pluginTitle, timeStamp, buildTimes, info } from './lib/log';
import {
  collectESBuildRunnerMessages,
  collectTSCRunnerMessages,
} from './lib/message-fragments';
import { normalizeBuildExecutorOptions } from './lib/normalize-schema';
import { resolveESBuildOption } from './lib/resolve-esbuild-option';
import chalk from 'chalk';
import fs from 'fs-extra';
import rimraf from 'rimraf';

export default function buildExecutor(
  rawOptions: ESBuildExecutorSchema,
  context: ExecutorContext
): AsyncIterableIterator<ExecutorResponse> | Promise<ExecutorResponse> {
  ensureProjectConfig(context);

  const {
    sourceRoot: projectSourceRoot,
    root: projectRoot,
  } = context.workspace.projects[context.projectName];

  const appsLayout = projectRoot.split('/')[0] ?? 'apps';

  const options = normalizeBuildExecutorOptions(
    rawOptions,
    context.root,
    context.projectName,
    projectSourceRoot,
    projectRoot,
    appsLayout
  );

  const esBuildOptions = resolveESBuildOption(options);

  if (esBuildOptions.platform === 'browser') {
    console.log(
      chalk.blue('i'),
      `Set ${info('BuildOptions.external')} as ${info('[]')} (or set ${info(
        'schema.externalDependencies'
      )} as ${info('none')} for browser builds.`
    );
  }

  let buildCounter = 1;

  const prefixESBuild = () =>
    `${pluginTitle('nx-plugin-esbuild')} ESBuild ${buildTimes(
      `[${buildCounter}]`
    )} ${timeStamp(dayjs().format('H:mm:ss A'))}`;

  const esBuildSubscriber: Observable<RunnerSubcriber> = runESBuild({
    ...esBuildOptions,
    assets: options.assets,
    failFast: options.failFast,
    watchDir: options.watchDir,
    watchOptions: options.extendWatchOptions,
    watchAssetsDir: options.watchAssetsDir,
  }).pipe(
    tap(() => {
      buildCounter++;
    }),

    map(
      ({ buildResult, buildFailure }): RunnerSubcriber => {
        const messageFragments: string[] = [];

        collectESBuildRunnerMessages(
          { buildResult, buildFailure },
          messageFragments,
          prefixESBuild()
        );

        return {
          success: !buildFailure,
          messageFragments,
        };
      }
    )

    // startWith({
    //   success: true,
    //   messageFragments: options.skipTypeCheck
    //     ? [`${chalk.blue('i')} ESBuild Compiler Starting...`]
    //     : [],
    // })
  );

  if (options.clearOutputPath) {
    const { outputPath } = options;
    if (fs.existsSync(outputPath)) {
      rimraf.sync(options.outputPath);
      console.log(
        chalk.blue('i'),
        `Output Path ${options.outputPath} Cleaned.`
      );
    }
  }

  const baseESBuildSubscriber = esBuildSubscriber.pipe(
    tap((buildResults: RunnerSubcriber) => {
      console.log(buildResults.messageFragments.join('\n'));
    }),
    map(
      (buildResults: RunnerSubcriber): ExecutorResponse => {
        return {
          success: buildResults?.success,
          outfile: path.join(options.outputPath, 'main.js'),
        };
      }
    ),
    catchError(() => {
      return of<ExecutorResponse>({
        success: false,
        outfile: undefined,
      });
    })
  );

  if (!options.watch && options.skipTypeCheck) {
    return baseESBuildSubscriber.toPromise();
  }

  if (options.watch && options.skipTypeCheck) {
    return eachValueFrom<ExecutorResponse>(baseESBuildSubscriber);
  }

  let typeCounter = 1;

  const prefixTsc = () =>
    `${pluginTitle('nx-plugin-esbuild')} TSC ${buildTimes(
      `[${typeCounter}]`
    )} ${timeStamp(dayjs().format('H:mm:ss A'))}`;

  const tscRunnerOptions: TscRunnerOptions = {
    tsconfigPath: options.tsconfigPath,
    watch: options.watch,
    root: options.workspaceRoot,
    failFast: options.failFast,
  };

  const tscSubscriber: Observable<RunnerSubcriber> = runTSC(
    tscRunnerOptions
  ).pipe(
    map((res) => {
      const { info, error, end } = res;
      const messageFragments: string[] = [];

      let hasErrors = Boolean(error);

      if (
        info &&
        info.match(/Found\s\d*\serror/) &&
        !info.includes('Found 0 errors')
      ) {
        hasErrors = true;
      }

      collectTSCRunnerMessages(res, messageFragments, prefixTsc());

      return { info, error, end, hasErrors, messageFragments };
    }),

    bufferUntil(
      ({ info, error }) =>
        // info中获得Found 1 errors这样的字样，说明tsc走完了一次编译
        !!info?.match(/Found\s\d*\serror/) ||
        !!error?.match(/Found\s\d*\serror/)
    ),

    tap(() => {
      typeCounter++;
    }),

    map((values) => {
      const message = values.map((value) => value.messageFragments).flat(1);

      return {
        success: !values.find((value) => value.hasErrors),
        messageFragments: message,
      };
    }),

    catchError(() => {
      return of<RunnerSubcriber>({
        success: false,
        messageFragments: [],
      });
    })
  );

  const baseSubscriber = options.useMergeCombine
    ? merge(esBuildSubscriber, tscSubscriber).pipe(
        startWith({
          success: true,
          messageFragments: [
            `${chalk.blue('i')} ESBuild Compiler Starting...`,
            `${chalk.blue('i')} TypeScript Compiler Starting...`,
          ],
        }),
        tap((res: RunnerSubcriber) => {
          console.log(res.messageFragments.join('\n'));
        }),
        map(
          (res): ExecutorResponse => {
            return {
              success: res?.success ?? true,
              outfile: path.join(options.outputPath, 'main.js'),
            };
          }
        )
      )
    : zip(esBuildSubscriber, tscSubscriber).pipe(
        startWith([
          {
            success: true,
            messageFragments: [
              `${chalk.blue('i')} ESBuild Compiler Starting...`,
            ],
          },
          {
            success: true,
            messageFragments: [
              `${chalk.blue('i')} TypeScript Compiler Starting...`,
            ],
          },
        ]),

        tap(([buildResults, tscResults]) => {
          console.log(tscResults.messageFragments.join('\n'));
          console.log(buildResults.messageFragments.join('\n'));
        }),

        map(
          ([buildResults, tscResults]): ExecutorResponse => {
            return {
              success: buildResults?.success && tscResults?.success,
              outfile: path.join(options.outputPath, 'main.js'),
            };
          }
        )
      );

  if (!options.watch) {
    return baseSubscriber.toPromise();
  }

  return eachValueFrom(baseSubscriber);
}

// map(([buildResults, tscResults]) =>
//   of<ExecutorResponse>({
//     success: buildResults?.success && tscResults?.success,
//     outfile: path.join(options.outputPath, 'main.js'),
//   })
// ),

// switchMap((res) => res)
