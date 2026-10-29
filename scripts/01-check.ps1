# 01-check.ps1 — проверка Windows 11 и места
# Запускай в PowerShell ОТ ИМЕНИ АДМИНИСТРАТОРА

# Показывает версию Windows (нужна 22H2+ = сборка 22621+)
winver
systeminfo | findstr /C:"OS Version"
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsHardwareAbstractionLayer | Format-List

# Свободное место (нужно >=10 ГБ для моделей)
Get-PSDrive C | Select-Object Used, Free | Format-List
# Альтернативно:
Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" | Select DeviceID, Size, FreeSpace

# Память и процессор (для оценки лёгких моделей)
Get-CimInstance Win32_ComputerSystem | Select TotalPhysicalMemory
Get-CimInstance Win32_Processor | Select Name, NumberOfCores, NumberOfLogicalProcessors
