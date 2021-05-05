/* eslint-disable @typescript-eslint/no-var-requires */
// forked from official @nrwl/node:build executor
// https://github.com/nrwl/nx/blob/master/packages/node/src/executors/build/build.impl.ts
// will apply modifications in the future
// you can also use @nrwl/node:build directly
import { ExecutorContext } from '@nrwl/devkit';

import { createProjectGraph } from '@nrwl/workspace/src/core/project-graph';
import {
  calculateProjectDependencies,
  checkDependentProjectsHaveBeenBuilt,
  createTmpTsConfig,
} from '@nrwl/workspace/src/utilities/buildable-libs-utils';
import { runWebpack } from './lib/webpack-runner';
import webpack, { Configuration } from 'webpack';

import { map, tap } from 'rxjs/operators';
import { eachValueFrom } from 'rxjs-for-await';
import { resolve } from 'path';

import { getNodeWebpackConfig } from '@nrwl/node/src/utils/node.config';
import { OUT_FILENAME } from '@nrwl/node/src/utils/config';
import { BuildNodeBuilderOptions } from '@nrwl/node/src/utils/types';
import { normalizeBuildOptions } from '@nrwl/node/src/utils/normalize';
import { generatePackageJson } from '@nrwl/node/src/utils/generate-package-json';
import { runWaitUntilTargets } from '../../utils/wait-until-targets';

import dotenv from 'dotenv';

dotenv.config();

export type NodeBuildEvent = {
  outfile: string;
  success: boolean;
};

export interface TmpNodeBuildExecutorSchema extends BuildNodeBuilderOptions {
  waitUntilTarget: string[];
  enableAnalytics: boolean;
}

export function buildExecutor(
  rawOptions: TmpNodeBuildExecutorSchema,
  context: ExecutorContext
) {
  const { enableAnalytics } = rawOptions;

  const { sourceRoot, root } = context.workspace.projects[context.projectName];

  if (!sourceRoot) {
    throw new Error(`${context.projectName} does not have a sourceRoot.`);
  }

  if (!root) {
    throw new Error(`${context.projectName} does not have a root.`);
  }

  const options = normalizeBuildOptions(
    rawOptions,
    context.root,
    sourceRoot,
    root
  );

  const projGraph = createProjectGraph();
  // 工作区所有项目以及依赖，如：
  //  'nx-plugin-koa': {
  //   name: 'nx-plugin-koa',
  //   type: 'lib',
  //   data: {
  //     root: 'packages/nx-plugin-koa',
  //     sourceRoot: 'packages/nx-plugin-koa/src',
  //     projectType: 'library',
  //     targets: [Object],
  //     tags: [Array],
  //     files: [Array]
  //   }
  // },
  // 'npm:tslib': {
  //   type: 'npm',
  //   name: 'npm:tslib',
  //   data: { version: '^2.2.0', packageName: 'tslib', files: [] }
  // },
  // console.log('projGraph nodes: ', projGraph.nodes);
  // 工作区所有项目的依赖，包括对其他项目的依赖与npm依赖
  // 包括static与implicit
  // static：对npm包的依赖
  // implicit：对其他工作区项目依赖
  // console.log('projGraph deps: ', projGraph.dependencies);
  // 是否单独构建buildable lib，还是直接导入文件
  if (!options.buildLibsFromSource) {
    const { target, dependencies } = calculateProjectDependencies(
      projGraph,
      context.root,
      context.projectName,
      context.targetName,
      context.configurationName
    );
    options.tsConfig = createTmpTsConfig(
      options.tsConfig,
      context.root,
      target.data.root,
      dependencies
    );

    if (
      !checkDependentProjectsHaveBeenBuilt(
        context.root,
        context.projectName,
        context.targetName,
        dependencies
      )
    ) {
      return { success: false };
    }
  }

  // 适用于构建库时，会生成package.json
  if (options.generatePackageJson) {
    generatePackageJson(context.projectName, projGraph, options);
  }

  const config: Configuration = options.webpackConfig.reduce(
    (currentConfig, plugin) => {
      return require(plugin)(currentConfig, {
        options,
        configuration: context.configurationName,
      });
    },
    getNodeWebpackConfig(options)
  );

  return eachValueFrom(
    runWebpack(config, webpack, context.projectName, enableAnalytics).pipe(
      tap((stats) => {
        console.info(
          stats.toString({
            timings: true,
            chunks: true,
            modules: true,
            colors: true,
          })
        );
      }),
      map((stats) => {
        return {
          success: !stats.hasErrors(),
          outfile: resolve(context.root, options.outputPath, OUT_FILENAME),
        } as NodeBuildEvent;
      })
    )
  );
}

export default buildExecutor;
