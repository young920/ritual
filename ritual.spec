name = "ritual"
noconfirm = True
onefile = True
clean = True
strip = False

# 不显示黑色 console 窗口(Mac/Win)
console = False

# 入口
script = "web/app.py"

# 打包数据(相对 ROOT)
datas = [
    ("web/static", "web/static"),
    ("web/templates", "web/templates"),
    ("web/data/demo.json", "web/data/demo.json"),
    ("data/exercises.json", "data/exercises.json"),
]

# 不打包的模块(运行时动态导入 / 太重)
excludes = [
    "tkinter",
    "matplotlib",
    "numpy.tests",
    "pandas",
    "PIL",
]

# Hooks(如果需要)
# from PyInstaller.utils.hooks import collect_data_files
# datas += collect_data_files("your_module")

# 输出
distpath = "dist"
workpath = "build"
specpath = "."
noupx = False  # 用 upx 压缩(Mac 默认有,Linux/Windows 单独装)