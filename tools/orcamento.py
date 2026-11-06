"""Read-only monthly planning adapter. No totals become transactions."""
import ast
import re
import unicodedata
from decimal import Decimal, ROUND_HALF_UP
from datetime import date, datetime
import openpyxl

MONTHS=['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro']
def norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKD',str(value or '').lower()) if not unicodedata.combining(c)).strip()

def planning_reference(path):
    book=openpyxl.load_workbook(path,read_only=True,data_only=False)
    # A bounded in-memory grid also avoids repeatedly streaming the XML per reference.
    cells={s.title:{c.coordinate:c.value for row in s.iter_rows(max_row=min(s.max_row,150),max_col=16) for c in row if c.value is not None} for s in book}
    def value(sheet,coord,trail=()):
        key=(sheet,coord)
        if key in trail: raise ValueError('Referência circular')
        v=cells[sheet].get(coord)
        if v is None: return Decimal(0)
        if isinstance(v,bool) or isinstance(v,(date,datetime)): raise ValueError('Tipo não monetário')
        if isinstance(v,(int,float,Decimal)): return Decimal(str(v))
        if not isinstance(v,str) or not v.startswith('='): raise ValueError('Valor não numérico')
        if '#REF!' in v: raise ValueError('Referência quebrada')
        expr=v[1:]
        def ref(match):
            title=(match[1] or sheet).strip("'")
            return str(value(title,match[2].replace('$',''),trail+(key,)))
        def summation(match):
            total=Decimal(0)
            for item in match[1].split(','):
                item=item.strip()
                m=re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)',item)
                if m:
                    from openpyxl.utils.cell import range_boundaries,get_column_letter
                    c1,r1,c2,r2=range_boundaries(item)
                    for rr in range(r1,r2+1):
                        for cc in range(c1,c2+1): total+=value(sheet,f'{get_column_letter(cc)}{rr}',trail+(key,))
                elif re.fullmatch(r'\$?[A-Z]+\$?\d+',item): total+=value(sheet,item.replace('$',''),trail+(key,))
                else: total+=Decimal(item)
            return str(total)
        expr=re.sub(r'SUM\(([^()]*)\)',summation,expr,flags=re.I)
        expr=re.sub(r"(?:(\'[^']+\'|[A-Za-zÀ-ú]+)!)?(\$?[A-Z]+\$?\d+)",ref,expr)
        tree=ast.parse(expr,mode='eval')
        def calc(node):
            if isinstance(node,ast.Expression): return calc(node.body)
            if isinstance(node,ast.Constant) and isinstance(node.value,(float,int)): return Decimal(str(node.value))
            if isinstance(node,ast.UnaryOp) and isinstance(node.op,(ast.USub,ast.UAdd)): return -calc(node.operand) if isinstance(node.op,ast.USub) else calc(node.operand)
            if isinstance(node,ast.BinOp):
                a,b=calc(node.left),calc(node.right)
                if isinstance(node.op,ast.Add): return a+b
                if isinstance(node.op,ast.Sub): return a-b
                if isinstance(node.op,ast.Mult): return a*b
                if isinstance(node.op,ast.Div): return a/b
            raise ValueError('Fórmula não suportada para importação segura')
        return calc(tree)
    def monetary(sheet,coord):
        if cells[sheet].get(coord) is None: return None,None
        try:
            v=value(sheet,coord)
            if not v.is_finite() or abs(v)>Decimal('90000000000000'): raise ValueError('Valor fora do limite')
            return str((v*100).quantize(Decimal('1'),rounding=ROUND_HALF_UP)),None
        except Exception as error: return None,str(error) if isinstance(error,ValueError) else 'Fórmula inválida'
    entries=[]
    def emit(sheet,month,labelcol,row,plannedcol,actualcol,notescol,purpose='expense',derived=False):
        label=cells[sheet].get(f'{labelcol}{row}')
        if not isinstance(label,str) or label.startswith('=') or norm(label) in ('total','categoria / item','caju'): return
        planned,error=monetary(sheet,f'{plannedcol}{row}') if plannedcol else (None,None)
        actual,actualerror=monetary(sheet,f'{actualcol}{row}')
        notes=cells[sheet].get(f'{notescol}{row}')
        key=norm(label)
        if any(t in key for t in ['cartao','cartoes','nubank']): purpose='card'
        if any(t in key for t in ['reserva','aporte','construtora','terreno','arquiteta']): purpose='saving'
        entries.append(dict(month=f'2026-{month:02}-01',sheet=sheet,cell=f'{plannedcol or actualcol}{row}',label=label.strip(),planned_cents=planned,actual_cents=actual,purpose=purpose,derived=derived,notes=str(notes or ''),error=error,actual_error=actualerror,formula=str(cells[sheet].get(f'{plannedcol or actualcol}{row}','')) if str(cells[sheet].get(f'{plannedcol or actualcol}{row}','')).startswith('=') else None))
    for sheet,grid in cells.items():
        if norm(sheet) not in MONTHS: continue
        month=MONTHS.index(norm(sheet))+1
        if month<=2:
            for rr in range(9,29):
                emit(sheet,month,'B',rr,'C','D','E')
                emit(sheet,month,'F',rr,'G','H','I')
            for rr in range(9,17): emit(sheet,month,'J',rr,'K','L','M','saving')
            for rr in range(21,29): emit(sheet,month,'J',rr,'K','L','M','card')
            for rr in range(2,6): emit(sheet,month,'F',rr,'G','H','I','income')
        else:
            section=''; benefit=False
            for rr in range(1,100):
                a=grid.get(f'A{rr}')
                heading=isinstance(a,str) and (any(norm(a).startswith(t) for t in ['investimentos & doacoes','doacoes','custos fixos','custos variaveis','estilo de vida']) or norm(a)=='caju')
                if heading:
                    section=norm(a);benefit=section=='caju'
                if heading or norm(a) in ('total','categoria / item','caju') or not isinstance(a,str): continue
                if any(x in section for x in ['doacoes','custos fixos','custos variaveis','estilo de vida','caju']):
                    emit(sheet,month,'A',rr,'B','B' if month>=10 else 'C','C' if month>=10 else 'D','benefit' if benefit else 'expense',month>=10)
            # Income remains a reference, never a second bank receipt.
            for rr in range(3,7): emit(sheet,month,'E' if month>=10 else 'F',rr,'F' if month>=10 else 'G','F' if month>=10 else 'H','G' if month>=10 else 'I','income',month>=10)
    book.close()
    return {'entries':entries,'year':2026,'currency':'BRL','method':'Valores digitados e fórmulas aritméticas resolvidas a partir das células; totais excluídos. Outubro/novembro derivados de Valor real mediante instrução do usuário.'}
