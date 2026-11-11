# FieldLedger 农业观测账本

支持站点目录、修订采集、隔离复核、窗口统计、质量检查、冻结式气候基准和带血缘的数据导出。观测按来源、站点、指标、时刻定位；来源优先级和质量状态会影响统计结果。

## 气候基准（climate baseline）

基准用于把当期观测与可复算的历史参照期对照，区分气候条件变化、站点覆盖变化和事后补录三类差异。

- 基准按**站点 + 指标 + 当地月份**计算：观测先按当地日（`offsetMinutes`）归并，日值再参与该月的历史分布；日归并沿用站点有效期、来源优先级（`preferred`/`all`）、质量标记（默认排除 `suspect`）以及指标自身的求和/均值口径。
- 每个月给出有效日数、中位数、四分位距（Q1、Q3、IQR）、最小/最大值和每个当期值的经验分位位置；IQR 为零、有效日数或年份不足、站点在月内启停时只标记 `interpretation.usable=false` 与原因，不产出异常结论。
- 区域基准同时保留两种口径：`fixed`（所有年份都有数据的固定共同站点面板）与 `available`（各期当期可用站点），并在 `excludedWeights` 中显式列出每个月被排除的站点及原因。
- 创建即冻结：基准记录创建时的序列、账本头、参数、每个观测的修订号/值/质量和校验和。补数或修订后只能新建基准，旧基准与已导出日报不会被改写；`baseline-compare` 输出参数变化、覆盖变化和观测修订三类差异。

```sh
node src/cli.js baseline-create --root DIRECTORY --input baseline.json
node src/cli.js baseline-position --root DIRECTORY --input position.json
node src/cli.js baseline-compare --root DIRECTORY --input compare.json
```


## 运行环境

使用 Node.js 22，核心功能依赖标准库。演示和测试只使用本地合成数据，不需要账户、设备或外部运行服务。请从项目根目录执行命令。

## 检查与运行

构建检查验证语法，测试使用临时数据目录，不会连接远端服务。

```sh
npm run build
npm test
npm run acceptance
```

演示会展示产品的实际数据处理和输出，运行结束自行退出。查看现有接口：

```sh
node src/cli.js help
```

## 目录与数据

src/ 保存领域逻辑和请求入口，tests/ 包含正常行为、边界与恢复测试。例子中的标识和记录为合成资料，不包含真实人员或生产测量。业务目录和本地数据库由调用者指定，应与源码分开保存。

## 干净环境复现

容器定义固定运行时版本。构建时准备环境，运行时无需网络；每次启动会复制只读源码到临时工作目录，测试产生的文件不会写回仓库。

```sh
docker build -t local-product-check .
docker run --rm --network none local-product-check
```
