import fs from 'fs';
import path from 'path';
import del from 'del';
import gulp from 'gulp';
import minimist from 'minimist';
import handlebars from 'gulp-compile-handlebars';
import handlebarsLayouts from 'handlebars-layouts';
import htmlmin from 'gulp-html-minifier';
import mailClient from 'gulp-mail';
import sass from 'gulp-sass';
import rename from 'gulp-rename';
import mergeStream from 'merge-stream';
import browserSync from 'browser-sync';
import S3 from 'aws-sdk/clients/s3';
import helpers from './src/handlebars/index';

const config = JSON.parse(fs.readFileSync('./conf/build.json', 'utf8'));
const { distPath, assetPaths, emailSenderPath, stylesPaths, views, tmpPath, email, aws, s3SourcePath } = config;
const { pagePath, pagesBasePath, layoutPath, partialPath, watchPath } = views;
const { username, password, host, secureConnection, port, from, to, subject, emailHTML } = email;

const getFileCss = (folderCss, fileName) => {
  const fullPathFileName = `${folderCss}${fileName}.css`;
  const fullPathSassFileName = `src\\styles\\pages\\${fileName}.scss`;

  if(!fs.existsSync(fullPathFileName)){
    throw new Error(`File not found: ${fullPathFileName}. Please add ${fullPathSassFileName}`);
  }

  let css = fs.readFileSync(fullPathFileName, 'utf8');

  return css;
};

export const html = () => {
  const hbEnv = handlebars.Handlebars;
  hbEnv.registerHelper(handlebarsLayouts(hbEnv));
  const configs = getConfigs();

  configs.inlineCss = getInlineCss();

  const options = {
    ignorePartials: true,
    batch: [ partialPath, layoutPath ],
    helpers,
  };

  const streams = [];
  fs.readdirSync(pagesBasePath).filter(file => path.extname(file) === '.hbs').forEach(file => {
    const nameFile = file.split('.')[0];
    const folderDistCss = `${tmpPath}styles/pages/`;
    const css = getFileCss(folderDistCss, nameFile);

    const stream = gulp.src(`${pagesBasePath}/${nameFile}.hbs`, { base: pagesBasePath, nodir: true })
      // .pipe(handlebars({...renderingVariables}, options))
      .pipe(handlebars({ ...configs, cssContent: `${css}` }, options))
      .pipe(rename({
        extname: '.html'
      }))
      .pipe(gulp.dest(tmpPath));
    streams.push(stream);
  });

  return mergeStream(streams);
};

export const minifyHtml = () => {
  return gulp.src(`${tmpPath}/*.html`)
    .pipe(htmlmin({ collapseWhitespace: true }))
    .pipe(gulp.dest(`${tmpPath}/minify`));
};

export const assets = () => {
  return gulp.src(assetPaths, { nodir: true })
    .pipe(rename({ dirname: '' }))
    .pipe(gulp.dest(`${tmpPath}assets`));
};

export const clean = () => del([ distPath, tmpPath, emailSenderPath ]);

export const styles = () => {
  return gulp.src(stylesPaths)
    .pipe(sass({
      // outputStyle: 'compressed',
      outputStyle: 'expanded',
    }).on('error', sass.logError))
    .pipe(gulp.dest(`${tmpPath}styles`));
};

export const hosting = () => {
  browserSync({
    notify: false,
    port: 8081,
    server: {
      baseDir: [ tmpPath ],
      index: 'pages.html'
    },
    startPath: 'example.html'
  });
};

const copyToDistPath = () => {
  return gulp.src([ `${tmpPath}**/*`, `!${tmpPath}styles/**/*` ], { nodir: true })
    .pipe(gulp.dest(distPath));
};

const copyToEmailSenderPath = () => {
  return gulp.src(`${tmpPath}**/*.html`)
    .pipe(gulp.dest(emailSenderPath));
};

const watch = () => {
  gulp.watch(assetPaths, { usePolling: true }, gulp.series(assets, copyToDistPath, copyToEmailSenderPath, reload));
  gulp.watch(stylesPaths, { usePolling: true }, gulp.series(styles, html, minifyHtml, copyToDistPath, copyToEmailSenderPath, reload));
  gulp.watch(watchPath, { usePolling: true }, gulp.series(html, minifyHtml, copyToDistPath, copyToEmailSenderPath, reload));
  // gulp.watch(localePaths, { usePolling: true }, localization);
};

function reload(done) {
  browserSync.reload();
  done();
}

function getConfigs() {
  const env = getRunningEnv();
  const envConf = require(`./conf/${env}.json`);

  return {
    ...envConf,
  };
}

function getInlineCss() {
  const cssContent = {};
  const cssPagePath = `${tmpPath}/styles/pages/`;

  fs.readdirSync(`${tmpPath}/styles/pages`).forEach(file => {
    const name = file.replace(/\.[^/.]+$/, '');
    //const required = require(Path.join(helperPath, file));
    const fileContent = fs.readFileSync(`${cssPagePath}${name}.css`, 'utf8');
    cssContent[name] = fileContent;
  });

  return cssContent;
}

function getRunningEnv() {
  return minimist(process.argv.slice(2)).env || 'development';
}

function getBuildSeries() {
  return gulp.series(clean, styles, gulp.parallel(assets, html), minifyHtml, copyToDistPath, copyToEmailSenderPath);
}

function clearS3Bucket(s3) {
  return new Promise ((resolve, reject) => {
    const s3params = {
      Bucket: aws.bucketName,
      MaxKeys: 100,
      Delimiter: '/',
    };

    s3.listObjectsV2 (s3params, (listObjError, data) => {
      if (listObjError) {
        return reject(listObjError);
      }

      if (data.Contents.length === 0) {
        return resolve();
      }

      const emptyS3Params = { Bucket: aws.bucketName };
      emptyS3Params.Delete = { Objects: [] };

      data.Contents.forEach(function(content) {
        emptyS3Params.Delete.Objects.push({ Key: content.Key });
      });

      // TODO handle case more than 100 objects
      s3.deleteObjects(emptyS3Params, function(deleteObjError) {
        if (deleteObjError) {
          return reject(deleteObjError);
        }

        resolve();
      });
    });
  });
}

function uploadFileS3(s3, bucketPath, filePath) {
  return new Promise ((resolve, reject) => {
    const uploadParams = { Bucket: aws.bucketName, Key: bucketPath, Body: fs.readFileSync(filePath), ACL: 'public-read' };
    s3.putObject(uploadParams, function(err) {
      if (err) {
        return reject(err);
      }
      // eslint-disable-next-line no-console
      console.log(`Successfully uploaded ${bucketPath} to ${aws.bucketName}`);
      resolve();
    });
  });
}

gulp.task('mail', async function () {
  const smtpInfo = {
    auth: {
      user: username,
      pass: password
    },
    host: host,
    secureConnection: secureConnection,
    port: port
  };

  emailHTML.forEach( function( fileName ) {
    let contentSuj = subject + ` of ${fileName}`;
    gulp.src(`${distPath}${fileName}`)
      .pipe(mailClient({
        subject: contentSuj,
        to: [
          ...to,
        ],
        from: from,
        smtp: smtpInfo
      }));
  });
});

gulp.task('publish', gulp.series(getBuildSeries(), async function() {
  const s3 = new S3 ({
    accessKeyId: aws.accessKey,
    secretAccessKey: aws.secret,
    region: aws.region,
  });

  try {
    await clearS3Bucket(s3);
    fs.readdirSync(s3SourcePath).forEach(function (fileName) {
      const filePath = path.join(s3SourcePath, fileName);
      const stat = fs.statSync(filePath);
      // TODO handle directory case
      if (stat.isFile()) {
        uploadFileS3(s3, fileName, filePath);
      }
    });

  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('Cannot publish to S3: ', err);
  }
}));

gulp.task('emptyS3', async function() {
  const s3 = new S3 ({
    accessKeyId: aws.accessKey,
    secretAccessKey: aws.secret,
    region: aws.region,
  });

  await clearS3Bucket(s3);
});

gulp.task('minify', minifyHtml);
gulp.task('dev', gulp.series(getBuildSeries(), gulp.parallel(hosting, watch)));
gulp.task('default', getBuildSeries());
