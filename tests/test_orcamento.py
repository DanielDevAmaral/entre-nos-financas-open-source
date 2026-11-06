import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import openpyxl
from tools.orcamento import planning_reference

class PlanningTests(unittest.TestCase):
    def test_planned_formulas_real_only_and_broken_references(self):
        with TemporaryDirectory() as folder:
            path=Path(folder)/'ficticio.xlsx'
            b=openpyxl.Workbook();s=b.active;s.title='Março'
            s['A1']='DOAÇÕES';s['A2']='CATEGORIA / ITEM';s['A3']='Oferta';s['B3']='=75*3';s['C3']=50;s['A4']='Dízimo';s['B4']='=#REF!*0.1';s['A5']='TOTAL';s['B5']='=SUM(B3:B4)'
            o=b.create_sheet('Outubro');o['A1']='CUSTOS FIXOS (MORADIA & OBRIGAÇÕES)';o['A2']='CATEGORIA / ITEM';o['A3']='Terapia';o['B3']='=90*2';o['C3']='PAGO';o['A4']='Sem valor'
            b.save(path);b.close();before=hashlib.sha256(path.read_bytes()).hexdigest()
            rows=planning_reference(path)['entries']
            self.assertEqual(next(r for r in rows if r['label']=='Oferta')['planned_cents'],'22500')
            self.assertIsNotNone(next(r for r in rows if r['label']=='Dízimo')['error'])
            terapia=next(r for r in rows if r['label']=='Terapia');self.assertTrue(terapia['derived']);self.assertEqual(terapia['planned_cents'],'18000');self.assertEqual(terapia['actual_cents'],'18000')
            self.assertIsNone(next(r for r in rows if r['label']=='Sem valor')['planned_cents'])
            self.assertFalse(any(r['label']=='TOTAL' for r in rows))
            self.assertEqual(before,hashlib.sha256(path.read_bytes()).hexdigest())

    def test_card_saving_and_income_are_distinct(self):
        with TemporaryDirectory() as folder:
            path=Path(folder)/'ficticio.xlsx';b=openpyxl.Workbook();s=b.active;s.title='Janeiro'
            for cell,v in {'F2':'Recebimento fictício','G2':5000,'H2':4900,'J9':'Reserva','K9':100,'J22':'Nubank Pessoa','K22':139,'L22':139,'F9':'Supermercado','G9':800}.items():s[cell]=v
            b.save(path);b.close();rows=planning_reference(path)['entries']
            self.assertEqual({r['label']:r['purpose'] for r in rows},{'Recebimento fictício':'income','Reserva':'saving','Nubank Pessoa':'card','Supermercado':'expense'})
