name: Pull Request

description: 提交代码、文档或测试数据改进

body:
  - type: markdown
    attributes:
      value: |
        感谢贡献。请在合并前确认以下事项：
  - type: checkboxes
    id: checks
    attributes:
      label: 提交前检查
      options:
        - label: 已运行 `npm test` 且全部通过。
          required: true
        - label: 上位机改动已在 Chrome/Edge 通过 localhost 手动验证。
          required: false
        - label: 未提交设备序列号、个人路径或敏感遥控数据。
          required: true
        - label: PR 说明中写明了硬件组合、串口参数、复现步骤与验证结果（如适用）。
          required: false
