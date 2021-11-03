/**
 * 1. 文件的读写
 * 2. 文件目录/文件的创建删除
 * 
 * 
 */

const fs = require('fs')
const path = require('path')
// 命令行交互工具
const inquirer = require('inquirer')
const rollup = require('rollup')
const chalk = require('chalk')
// 压缩模块
const zlib = require('zlib')
// 删除文件和文件夹
const rimraf = require('rimraf')
const typescript = require('rollup-plugin-typescript2')
const uglify = require('rollup-plugin-uglify').uglify
// 调用shell和本地外部程序
const execa = require('execa')
const ora = require('ora')
const spinner = ora({
  prefixText: `${chalk.green('\n[building tasks]')}`
})

// 获取需要打包的文件目录
function getPackagesName () {
  let ret
  let all = fs.readdirSync(resolve('packages'))
  // drop hidden file whose name is startWidth '.'
  // drop packages which would not be published(eg: examples and docs)
  ret = all
        .filter(name => {
          const isHiddenFile = /^\./g.test(name)
          return !isHiddenFile
        }).filter(name => {
          const isPrivatePackages = require(resolve(`packages/${name}/package.json`)).private
          return !isPrivatePackages
        })

  return ret
}

// 清除旧的打包结果
function cleanPackagesOldDist(packagesName) {
  packagesName.forEach(name => {
    const distPath = resolve(`packages/${name}/dist`)
    const typePath = resolve(`packages/${name}/dist/types`)
    // 删除目录创建目录
    if (fs.existsSync(distPath)) {
      rimraf.sync(distPath)
    }

    fs.mkdirSync(distPath)
    fs.mkdirSync(typePath)
  })
}

function resolve(p) {
  return path.resolve(__dirname, '../', p)
}

function PascalCase(str){
  const re=/-(\w)/g;
  const newStr = str.replace(re, function (match, group1){
      return group1.toUpperCase();
  })
  return newStr.charAt(0).toUpperCase() + newStr.slice(1);
}

const generateBanner = (packageName) => {
  let ret =
  '/*!\n' +
  ' * better-scroll / ' + packageName + '\n' +
  ' * (c) 2016-' + new Date().getFullYear() + ' ustbhuangyi\n' +
  ' * Released under the MIT License.\n' +
  ' */'
  return ret
}


// 输出的三种格式
const buildType = [
  {
    format: 'umd',
    ext: '.js'
  },
  {
    format: 'umd',
    ext: '.min.js'
  },
  {
    format: 'es',
    ext: '.esm.js'
  }
]

// 生成打包配置 return  packagesName * buildType 的打包配置
function generateBuildConfigs(packagesName) {
  const result = []
  packagesName.forEach(name => {
    buildType.forEach((type) => {
      let config = {
        input: resolve(`packages/${name}/src/index.ts`),
        output: {
          file: resolve(`packages/${name}/dist/${name}${type.ext}`),
          name: PascalCase(name),
          format: type.format,
          banner: generateBanner(name)
        },
        plugins: generateBuildPluginsConfigs(type.ext.indexOf('min')>-1, name)
      }
      // rename
      if (name === 'core' && config.output.format !== 'es') {
        config.output.name = 'BScroll'
        /** Disable warning for default imports */
        config.output.exports = 'named'
        // it seems the umd bundle can not satisfies our demand
        config.output.footer = 'if(typeof window !== "undefined" && window.BScroll) { \n' +
                              '  window.BScroll = window.BScroll.default;\n}'
      }
      // rollup will valiate config properties of config own and output a warning.
      // put packageName in prototype to ignore warning.
      Object.defineProperties(config, {
        'packageName': {
          value: name
        },
        'ext': {
          value: type.ext
        }
      })
      result.push(config)
    })
  })
  return result
}
// 生成打包插件
function generateBuildPluginsConfigs(isMin) {
  const tsConfig = {
    verbosity: -1,
    tsconfig: path.resolve(__dirname, '../tsconfig.json'),
  }
  const plugins = []
    if (isMin) {
      // 压缩插件
      plugins.push(uglify())
    }
  // rollup 打包ts需要的插件
  plugins.push(typescript(tsConfig))
  return plugins
}

// 实际的打包过程，builds 是三个类型的打包配置
function build(builds) {
  let built = 0
  const total = builds.length
  // 看起来是打算继发
  const next = () => {
    buildEntry(builds[built], built + 1, () => {
      builds[built-1] = null
      built++
      if (built < total) {
        next()
      }
    })
  }
  next()
}

function buildEntry(config, curIndex, next) {
  const isProd = /min\.js$/.test(config.output.file)

  spinner.start(`${config.packageName}${config.ext} is buiding now. \n`)

  // rollup 打包流程，怎么形成严格的继发流程，上一个打包结束开始下一个，中间没有重叠过程
  rollup.rollup(config).then((bundle) => {
    bundle.write(config.output).then(({ output }) => {
      const code = output[0].code

      spinner.succeed(`${config.packageName}${config.ext} building has ended.`)

      function report(extra) {
        console.log(chalk.magenta(path.relative(process.cwd(), config.output.file)) + ' ' + getSize(code) + (extra || ''))
        next()
      }
      if (isProd) {
        zlib.gzip(code, (err, zipped) => {
          if (err) return reject(err)
          let words =  `(gzipped: ${chalk.magenta(getSize(zipped))})`
          report(words)
        })
      } else {
        report()
      }

      // since we need bundle code for three types
      // just generate .d.ts only once
      if (curIndex % 3 === 0) {
        copyDTSFiles(config.packageName)
      }
    })
  }).catch((e) => {
    // 看起来一个失败，后面的不需要继续
    spinner.fail('buiding is failed')
    console.log(e)
  })
}

function copyDTSFiles (packageName) {
  console.log(chalk.cyan('> start copying .d.ts file to dist dir of packages own.'))
  const sourceDir = resolve(`packages/${packageName}/dist/packages/${packageName}/src/*`)
  const targetDir = resolve(`packages/${packageName}/dist/types/`)
  execa.commandSync(`mv ${sourceDir} ${targetDir}`, { shell: true })
  console.log(chalk.cyan('> copy job is done.'))
  rimraf.sync(resolve(`packages/${packageName}/dist/packages`))
  rimraf.sync(resolve(`packages/${packageName}/dist/node_modules`))
}

function getSize(code) {
  return (code.length / 1024).toFixed(2) + 'kb'
}

// 获取最终选中的packages
const getAnswersFromInquirer = async (packagesName) => {
  const question = {
    type: 'checkbox',
    name: 'packages',
    scroll: false,
    message: 'Select build repo(Support Multiple selection)',
    choices: packagesName.map(name => ({
      value: name,
      name
    }))
  }
  // 利用 inquirer 创建问题
  let { packages } = await inquirer.prompt(question)
  // make no choice
  if (!packages.length) {
    console.log(chalk.yellow(`
      It seems that you did't make a choice.

      Please try it again.
    `))
    return
  }

  // chose 'all' option
  if (packages.some(package => package === 'all')) {
    packages = getPackagesName()
  }
  const { yes } = await inquirer.prompt([{
    name: 'yes',
    message: `Confirm build ${packages.join(' and ')} packages?`,
    type: 'list',
    choices: ['Y', 'N']
  }])

  if (yes === 'N') {
    console.log(chalk.yellow('[release] cancelled.'))
    return
  }

  return packages
}

const buildBootstrap = async () => {
  const packagesName = getPackagesName()
  // provide 'all' option
  packagesName.unshift('all')

  const answers = await getAnswersFromInquirer(packagesName)
  console.log('zza:', answers)
  if (!answers) return

  cleanPackagesOldDist(answers)

  const buildConfigs = generateBuildConfigs(answers)

  build(buildConfigs)

}
buildBootstrap().catch(err => {
  console.error(err)
  // 退出当前进程
  process.exit(1)
})
