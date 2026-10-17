{
  "targets": [{
    "target_name": "clipboard-policy-test",
    "type": "executable",
    "win_delay_load_hook": "false",
    "sources": ["policy-test.cc", "../../../vendor/selection-hook/src/windows/lib/transient.cc"],
    "msvs_settings": { "VCCLCompilerTool": { "ExceptionHandling": "1" } }
  }]
}
