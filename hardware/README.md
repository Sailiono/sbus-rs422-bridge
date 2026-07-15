# Hardware

本目录用于发布隔离 SBUS → RS-422 透明桥接硬件。

SPDX-License-Identifier: `CERN-OHL-P-2.0`

Copyright © 2026 Clark Cui and project contributors

## 当前状态

硬件已经完成样机和上位机联调，第一版可读原理图已经公开：

- [`sbus-rs422-bridge-schematic.pdf`](sbus-rs422-bridge-schematic.pdf)：单页 A4 横版原理图，包含供电、SBUS 输入与反相、隔离 RS-422 收发、模式选择和差分接口。

可编辑原理图源文件、PCB、BOM、制造文件及版本标识仍在整理中，因此当前提交用于设计理解与评审，不构成完整的可生产硬件包。

请不要根据本页的功能描述自行生产或接入高风险控制系统。

## 已验证的设计目标

- 接收反向电平 SBUS；
- 保持 `100000 bit/s / 8E2`、帧率和 25 字节数据内容不变；
- 输出 RS-422 互补差分信号；
- SBUS 输入地与 RS-422 输出地电气隔离；
- 支持通过 USB→RS-422 适配器接入本仓库上位机；
- 已使用标准 SBUS 信号源完成连续收发、帧解析和输入/输出一致性验证。

## 目录与计划发布内容

```text
hardware/
├── sbus-rs422-bridge-schematic.pdf   已发布的原理图
├── LICENSE                           CERN-OHL-P-2.0
├── schematic/       原理图源文件与 PDF
├── pcb/             PCB 源文件、Gerber 与钻孔文件
├── bom/             BOM 与替代料说明
├── mechanical/      尺寸、接口和装配资料
└── test/            测试点、端接和验收说明
```

## 许可证

本目录中的硬件设计资料作为 Covered Source，依据 [CERN Open Hardware Licence Version 2 - Permissive](LICENSE)（`CERN-OHL-P-2.0`）发布。软件仍适用仓库根目录的 MIT License。

原理图 PDF 是当前公开版本；后续加入的可编辑设计源文件、PCB 和制造资料如果没有单独声明，也适用同一硬件许可证。
