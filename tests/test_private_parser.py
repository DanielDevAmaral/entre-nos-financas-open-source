import base64
from http.server import HTTPServer
import json
import os
from threading import Thread
import unittest
from urllib.request import Request,build_opener,ProxyHandler
from urllib.error import HTTPError
from api.private_parser import handler

class PrivateParserTests(unittest.TestCase):
    def test_token_format_and_original_currency_guard(self):
        old=os.environ.get('PARSER_TOKEN');token='test-only-secret-32-characters-long'
        os.environ['PARSER_TOKEN']=token
        server=HTTPServer(('127.0.0.1',0),handler)
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        opener=build_opener(ProxyHandler({}))
        def request(body,secret=None):
            req=Request('http://127.0.0.1:'+str(server.server_port),data=(json.dumps(body).encode() if secret else b""),method="POST",headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+secret} if secret else {})})
            try:
                with opener.open(req,timeout=3) as r:return r.status,json.load(r)
            except HTTPError as e:return e.code,json.load(e)
        try:
            self.assertEqual(request({})[0],403)
            self.assertEqual(request({'extension':'../.env','currency':'BRL','data':'eA=='},token)[0],400)
            self.assertEqual(request({'extension':'.csv','currency':'BRL','data':'not base64'},token)[0],400)
        finally:
            server.shutdown();server.server_close();thread.join()
            if old is None:os.environ.pop('PARSER_TOKEN',None)
            else:os.environ['PARSER_TOKEN']=old

if __name__=='__main__':unittest.main()
