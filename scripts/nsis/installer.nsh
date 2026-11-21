# electron-builder 25 читает /D= через StdUtils.GetParameter: некавыченный
# путь с пробелами обрезается. NSIS требует /D= последним и без кавычек;
# автообновление через Node может передать весь аргумент в кавычках.
# Исправляем только явно заданный /D=, не меняя обычный выбор каталога в UI.
!macro customInit
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ${StdUtils.GetAllParameters} $R8 "0"
  StrCpy $R9 ""
  StrLen $R7 $R8
  StrCpy $R6 0
  ${DoWhile} $R6 < $R7
    StrCpy $R5 $R8 3 $R6
    ${If} $R5 == "/D="
    ${OrIf} $R5 == "/d="
      # StdUtils разбирает кавычки правильно. В обычном некавыченном NSIS
      # формате весь остаток командной строки является каталогом.
      StrCpy $R5 ""
      ${If} $R6 > 0
        IntOp $R5 $R6 - 1
        StrCpy $R5 $R8 1 $R5
      ${EndIf}
      ${If} $R5 == '"'
        ${StdUtils.GetParameter} $R9 "D" ""
      ${Else}
        IntOp $R6 $R6 + 3
        StrCpy $R9 $R8 "" $R6
      ${EndIf}
      ${Break}
    ${EndIf}
    IntOp $R6 $R6 + 1
  ${Loop}
  ${If} $R9 != ""
    StrCpy $INSTDIR $R9
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
!macroend
