# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['web/app.py'],
    pathex=[],
    binaries=[],
    datas=[('web/static', 'web/static'), ('web/templates', 'web/templates'), ('web/data/demo.json', 'web/data/demo.json'), ('data/exercises.json', 'data/exercises.json')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='ritual',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['dist/Ritual.icns'],
)
