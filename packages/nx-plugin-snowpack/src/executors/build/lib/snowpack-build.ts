import { NormalizedSnowpackBuildSchema } from '../schema';
import { from, Observable, of } from 'rxjs';
import { tap, switchMap } from 'rxjs/operators';
import { build, clearCache } from 'snowpack';
import { loadSnowpackConfig, createSnowpackConfig } from './nomalize-config';
import { RunnerResponse } from '../../../utils/types';
import chalk from 'chalk';

export const snowpackBuild = (
  options: NormalizedSnowpackBuildSchema
): Observable<RunnerResponse> => {
  const configResolver = options.configPath
    ? loadSnowpackConfig(options)
    : of(createSnowpackConfig(options));

  const configLoadInfo = options.configPath
    ? `Using External Config File`
    : 'Using Internal Default Config';

  return from(configResolver).pipe(
    tap(() => {
      console.log(chalk.blue('i'), chalk.green('Nx-Snowpack [Build] Starting'));
      console.log(chalk.blue('i'), chalk.green(configLoadInfo));
    }),
    switchMap((config) => {
      return new Observable<RunnerResponse>((subscriber) => {
        (options.clearCache ? clearCache() : Promise.resolve()).then(() => {
          build({ config })
            .then((buildResult) => {
              // buildResult.onFileChange
              subscriber.next({
                success: true,
              });
            })
            .catch((error) =>
              subscriber.error({
                success: false,
                error,
              })
            );
        });
      });
    })
  );
};
