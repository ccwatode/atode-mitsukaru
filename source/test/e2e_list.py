"""
お知らせ一覧PDFの取り込み → ジャンル選択 → 添付の追加 のブラウザ検証（iPhone相当の画面・タッチ）。
架空の文章と、この場で作ったPDF・画像だけを使う。
使い方: python3 test/e2e_list.py <dist> <出力先>
"""
import base64, functools, http.server, io, math, os, sys, threading
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright, expect

DIST, OUT = sys.argv[1:3]
os.makedirs(OUT, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8783), functools.partial(Q, directory=DIST))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8783/'

def jpeg(seed):
    im = Image.new('RGB', (800, 600), (240 - seed * 20, 200, 150 + seed * 15))
    d = ImageDraw.Draw(im)
    for k in range(6):
        d.ellipse([60 + k * 110 + seed * 7, 120 + (k * 53 + seed * 31) % 300, 180 + k * 110, 260 + (k * 53 + seed * 31) % 300], fill=(200 - k * 20, 90 + seed * 25, 60 + k * 30))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=85); return b.getvalue()
IMGS = [jpeg(i) for i in range(4)]
img_tag = lambda i: f'<img src="data:image/jpeg;base64,{base64.b64encode(IMGS[i]).decode()}">'

def disp_size(n):  # 元サービスの表示：1024で割って小数1桁に切り上げ
    kb = n / 1024
    return f'{math.ceil(kb * 10) / 10:.1f}KB' if kb < 1024 else f'{math.ceil(kb / 1024 * 10) / 10:.1f}MB'

CSS = """
body{font-family:sans-serif;margin:24px;width:520px}
.date{font-size:14px;margin:26px 0 10px}
.tags{font-size:12px;margin:14px 0 6px}.tags span{margin-right:14px}
.title{font-size:16px;font-weight:bold;line-height:1.25;margin:0 0 10px}
.body{font-size:16px;line-height:1.5;margin:0;white-space:pre-wrap}
.att{font-size:16px;line-height:1.5;padding-left:29px;margin:6px 0}
img{width:300px;display:block;margin:8px 0}
"""
def post(title, body, end, imgs=(), atts=()):
    h = f'<div class="tags"><span>ひまわり園</span><span>山田はな</span></div><p class="title">{title}</p><p class="body">{body} {end}</p>'
    h += ''.join(img_tag(i) for i in imgs) + ''.join(f'<p class="att">{n} ({s})</p>' for n, s in atts)
    return h
FULL, MORE = '小さくする', '… もっとみる'

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS' if ok else 'FAIL'), name, detail)

with sync_playwright() as p:
    b = p.chromium.launch()
    # --- 架空のPDFを作る ---
    g = b.new_page()
    def make_pdf(html, path):
        g.set_content(f'<meta charset="utf-8"><style>{CSS}</style>{html}')
        g.pdf(path=path, format='A4', print_background=True)
    make_pdf('<h1>運動会のご案内</h1><p>日時：10月10日（土）9:00〜12:00</p><p>場所：ひまわり園 園庭</p>' + '<p>持ち物：水筒、帽子、タオル。</p>' * 3, f'{OUT}/a8f3c2.pdf')
    make_pdf('<h1>園だより 10月号</h1>' + '<p>秋が深まり、園庭の木々も色づいてきました。今月は遠足と運動会があります。</p>' * 30, f'{OUT}/77b1e9.pdf')
    s_undo, s_tayori = disp_size(os.path.getsize(f'{OUT}/a8f3c2.pdf')), disp_size(os.path.getsize(f'{OUT}/77b1e9.pdf'))
    assert s_undo != s_tayori
    undokai = post('【運動会のお知らせ】', '下記のとおり運動会を行います。\n日時：10月10日（土）9:00〜12:00\n場所：ひまわり園 園庭\n参加申込書は10月7日（水）までに提出してください。', FULL, atts=[('運動会のご案内.pdf', s_undo)])
    kyu5 = post('給食', '今日の給食です。ごはん、さばのみそ煮、ほうれん草のおひたし、みそ汁でした。', FULL, imgs=(0, 1))
    kyu2 = post('給食', '今日の給食です。カレーライス、フルーツヨーグルトでした。', FULL, imgs=(2,))
    tayori_short = post('10月の園だより', '秋が深まり、園庭の木々も色づいてきました。今月の予定をお知らせします。', MORE, atts=[('園だより10月号.pdf', s_tayori)])
    tayori_full = post('10月の園だより', '秋が深まり、園庭の木々も色づいてきました。今月の予定をお知らせします。\n10月20日（火）は遠足です。お弁当と水筒を持たせてください。雨の場合は園内で過ごします。', FULL, atts=[('園だより10月号.pdf', s_tayori)])
    kyu6 = post('給食', '今日の給食です。うどん、かぼちゃの煮物、りんごでした。', FULL, imgs=(3,))
    d = lambda x: f'<p class="date">{x}</p>'
    make_pdf(d('2026-10-05') + undokai + kyu5 + d('2026-10-02') + kyu2 + d('2026-10-01') + tayori_short, f'{OUT}/list1.pdf')
    make_pdf(d('2026-10-06') + kyu6 + d('2026-10-05') + undokai + kyu5 + d('2026-10-02') + kyu2 + d('2026-10-01') + tayori_full, f'{OUT}/list2.pdf')
    make_pdf('<h1>お弁当の日のお願い</h1><p>毎月第3金曜日はお弁当の日です。</p>', f'{OUT}/other.pdf')
    g.close()

    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
                        timezone_id='Asia/Tokyo', locale='ja-JP')
    ctx.add_init_script("delete ReadableStream.prototype[Symbol.asyncIterator]; delete ReadableStream.prototype.values;")
    page = ctx.new_page()
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.on('request', lambda r: requests.append(r.url))
    nav = page.get_by_role('navigation', name='画面の切り替え')
    dlg = lambda name: page.get_by_role('dialog', name=name)
    shot = lambda n: page.screenshot(path=f'{OUT}/{n}.png')
    cards = page.get_by_test_id('post-card')
    card = lambda title, nth=0: cards.filter(has=page.get_by_role('heading', name=title, exact=True)).nth(nth)
    picked = lambda c: c.locator('.gchip.on span').first.inner_text()

    page.goto(URL)
    expect(nav).to_be_visible()

    # --- 1. 追加の入口と、一覧PDFの読み取り ---
    nav.get_by_role('button', name='追加').click()
    sheet = dlg('何を追加しますか？')
    check('追加の一番上に「お知らせ一覧のPDF」', sheet.locator('.add-opt').first.inner_text().startswith('お知らせ一覧のPDF'))
    sheet.get_by_text('お知らせ一覧のPDFの作り方').click()
    check('PDFの作り方（共有→オプション→PDF）を案内', 'オプション' in sheet.inner_text() and 'PDF' in sheet.inner_text())
    shot('l01_add_sheet')
    sheet.get_by_role('button', name='やめる').click()
    page.get_by_test_id('listpdf-input').set_input_files(f'{OUT}/list1.pdf')
    expect(page.get_by_role('heading', name='お知らせの取り込み')).to_be_visible(timeout=30000)
    check('4件を記事ごとに分けて表示', cards.count() == 4, str(cards.count()))
    check('期間を表示', '2026年10月1日' in page.locator('.lr-range').inner_text() and '10月5日' in page.locator('.lr-range').inner_text(), page.locator('.lr-range').inner_text())

    # --- 2. ジャンルの候補 ---
    check('提案：給食→給食／園だより→園だより／運動会→行事', picked(card('給食')) == '給食' and picked(card('10月の園だより')) == '園だより' and picked(card('【運動会のお知らせ】')) == '行事',
          ' / '.join([picked(card('給食')), picked(card('10月の園だより')), picked(card('【運動会のお知らせ】'))]))
    check('候補に「提案」の印', '提案' in card('給食').locator('.genre-picker').inner_text())
    t = card('10月の園だより').inner_text()
    check('途中までの本文と、あとで追加する添付を表示', '本文は途中まで' in t and '園だより10月号.pdf' in t and s_tayori in t and 'あとで追加' in t, t.replace('\n', ' | ')[:160])
    check('記事に写真を紐づけ（2枚・1枚）', '2枚' in card('給食', 0).inner_text() and '1枚' in card('給食', 1).inner_text() and card('給食', 0).locator('.thumb img').count() == 2)
    shot('l02_review')

    # --- 3. 新しいジャンルを作る。同じ題名の記事にも反映 ---
    c0 = card('給食', 0)
    c0.get_by_role('button', name='新しく作る').click()
    c0.get_by_label('新しいジャンルの名前').fill('きゅうしょく')
    c0.get_by_role('button', name='決定').click()
    check('新しいジャンルを選べる', picked(card('給食', 0)) == 'きゅうしょく')
    check('同じ題名の記事もまとめて変わる', picked(card('給食', 1)) == 'きゅうしょく' and '同じ題名の1件も' in page.locator('.lr-note').inner_text())
    card('給食', 1).get_by_role('radio', name='活動記録').click() if card('給食', 1).get_by_role('radio', name='活動記録').count() else None
    card('給食', 1).get_by_role('radio', name='きゅうしょく').click()
    shot('l03_genre_changed')
    go_btn = page.get_by_role('button', name='4件を取り込む（写真3枚）')
    check('取り込みボタンに件数と写真数', go_btn.count() == 1)
    go_btn.click()
    done = dlg('取り込みが終わりました')
    expect(done).to_be_visible(timeout=30000)
    t = done.inner_text()
    check('結果：4件・写真3枚・添付2件はあとで', '4件' in t and '3枚' in t and '2件' in t, t.replace('\n', ' | '))
    shot('l04_result')
    done.get_by_role('button', name='閉じる').click()

    # --- 4. ホーム：ジャンルで絞り込み ---
    chips = page.locator('.chips').last
    names = [x.strip() for x in chips.locator('.chip').all_inner_texts()]
    check('ホームにジャンルの絞り込み', names[0] == 'すべて' and set(names[1:]) == {'きゅうしょく', '園だより', '行事'}, str(names))
    chips.get_by_role('button', name='きゅうしょく').click()
    check('ジャンルで絞り込める（給食2件）', page.locator('.entry').count() == 2 and page.locator('.entry .genre-tag').first.inner_text() == 'きゅうしょく')
    check('一覧に写真のサムネイル', page.locator('.entry .thumb img').count() == 3)
    chips.get_by_role('button', name='すべて').click()
    shot('l05_home')

    # --- 5. 添付をまとめて追加（大きさで元の記事を探す） ---
    ban = page.get_by_role('button', name='添付ファイル 2件がまだ入っていません')
    check('未保存の添付をホームで案内', ban.count() == 1)
    ban.click()
    expect(page.get_by_role('heading', name='添付の追加')).to_be_visible()
    check('未保存の添付の一覧', page.locator('.miss-row').count() == 2 and '運動会のご案内.pdf' in page.locator('.entries').inner_text())
    shot('l06_missing')
    page.get_by_test_id('fill-input').set_input_files([f'{OUT}/a8f3c2.pdf', f'{OUT}/77b1e9.pdf', f'{OUT}/other.pdf'])
    ask = dlg('どの記事の添付ですか？')
    expect(ask).to_be_visible(timeout=30000)
    check('大きさの合う2件は自動で記事に入る', page.get_by_text('2件の添付を記事に入れました').count() == 1 and page.locator('.miss-row').count() == 0)
    check('合わないファイルは勝手に入れずに確認', 'other.pdf' in ask.inner_text() and '場所（未保存の添付）がありません' in ask.inner_text(), ask.inner_text().replace('\n', ' | '))
    ask.get_by_role('button', name='閉じる').click()
    page.get_by_role('button', name='戻る').click()
    check('案内が消える', page.get_by_role('button', name='添付ファイル').count() == 0)

    # --- 6. 記事の詳細：添付・ジャンル・予定 ---
    page.locator('.entry', has_text='【運動会のお知らせ】').click()
    expect(page.locator('.detail-title')).to_have_text('【運動会のお知らせ】')
    check('添付PDFが元の名前で記事に付く', page.get_by_role('button', name='運動会のご案内.pdfを開く').count() == 1)
    check('詳細にジャンルを表示', page.locator('.detail-head .genre-tag').inner_text() == '行事')
    check('取り込んだ記事から予定の候補', '予定の候補' in page.locator('.src-events').inner_text(), page.locator('.src-events').inner_text().replace('\n', ' | ')[:80])
    page.locator('.post-extras .gchip.on').click()
    pk = page.locator('.post-extras .genre-picker')
    check('詳細の候補に、過去に使ったジャンルも出る', 'きゅうしょく' in pk.inner_text() and '園だより' in pk.inner_text(), pk.inner_text().replace('\n', ' '))
    pk.get_by_role('radio', name='園だより').click()
    expect(page.get_by_text('ジャンルを「園だより」にしました')).to_be_visible()
    check('詳細でジャンルを変更', page.locator('.detail-head .genre-tag').inner_text() == '園だより')
    shot('l07_detail')
    page.get_by_role('button', name='戻る').click()

    page.locator('.entry', has_text='10月の園だより').click()
    check('途中までの本文は詳細で知らせる', '本文は途中までです' in page.locator('.post-extras').inner_text())
    page.get_by_role('button', name='戻る').click()

    # --- 7. 検索：ジャンル・添付の名前・添付PDFの中の文字 ---
    page.locator('.search-launch').click()
    box = page.get_by_role('searchbox') if page.get_by_role('searchbox').count() else page.locator('.search-bar input')
    box.fill('園だより10月号')
    expect(page.locator('.result')).to_have_count(1)
    check('添付の名前で検索', '10月の園だより' in page.locator('.result').inner_text())
    box.fill('水筒 帽子')
    expect(page.locator('.result')).to_have_count(1)
    check('添付PDFの中の文字で検索', '運動会' in page.locator('.result').inner_text(), page.locator('.result').inner_text().replace('\n', ' | ')[:120])
    nav.get_by_role('button', name='ホーム').click()

    # --- 8. 同じPDFをもう一度：重複しない ---
    page.get_by_test_id('listpdf-input').set_input_files(f'{OUT}/list1.pdf')
    expect(page.get_by_role('heading', name='新しい記事はありません')).to_be_visible(timeout=30000)
    check('同じPDFの再取り込みは重複しない', cards.count() == 0 and page.get_by_role('button', name='取り込む記事なし').is_disabled())
    page.get_by_role('button', name='やめる').click()

    # --- 9. 次の週のPDF：新しい記事だけ追加。過去のジャンルが候補の先頭 ---
    page.get_by_test_id('listpdf-input').set_input_files(f'{OUT}/list2.pdf')
    expect(page.get_by_role('heading', name='お知らせの取り込み')).to_be_visible(timeout=30000)
    check('新しい1件だけを表示', cards.count() == 1 and '取り込み済み3件' in page.locator('.lr-counts').inner_text(), page.locator('.lr-counts').inner_text())
    first = card('給食').locator('.gchip').first
    check('過去に選んだジャンルが先頭で選択済み（「前回」の印）', picked(card('給食')) == 'きゅうしょく' and '前回' in first.inner_text(), first.inner_text())
    check('提案も選択肢に残る', card('給食').get_by_role('radio', name='給食').count() >= 1)
    fuller = page.locator('.lr-fuller')
    check('全文になった記事は更新の対象', '10月の園だより' in fuller.inner_text() and '本文が全文に' in fuller.inner_text() and fuller.get_by_role('checkbox').is_checked())
    shot('l08_second_pdf')
    page.get_by_role('button', name='2件を取り込む（写真1枚）').click()
    done = dlg('取り込みが終わりました')
    expect(done).to_be_visible(timeout=30000)
    check('結果：追加1件・更新1件', '1件' in done.inner_text() and '内容を更新：1件' in done.inner_text(), done.inner_text().replace('\n', ' | '))
    done.get_by_role('button', name='閉じる').click()
    check('記事は5件（重複なし）', page.locator('.entry').count() == 5, str(page.locator('.entry').count()))
    page.locator('.entry', has_text='10月の園だより').click()
    body = page.locator('.detail').inner_text()
    check('本文が全文に置き換わり、添付は残る', '遠足' in body and '本文は途中までです' not in body and page.get_by_role('button', name='園だより10月号.pdfを開く').count() == 1)
    page.get_by_role('button', name='戻る').click()

    # --- 10. 写真タブ・一覧ではないPDF・通信 ---
    nav.get_by_role('button', name='写真').click()
    check('写真タブにお知らせの写真4枚', page.locator('.photo-grid .thumb').count() == 4, str(page.locator('.photo-grid .thumb').count()))
    shot('l09_photos')
    nav.get_by_role('button', name='ホーム').click()
    page.get_by_test_id('listpdf-input').set_input_files(f'{OUT}/other.pdf')
    expect(page.locator('.notice-error')).to_be_visible(timeout=30000)
    check('一覧でないPDFは取り込まずに案内', 'お知らせ一覧のPDFではない' in page.locator('.notice-error').inner_text(), page.locator('.notice-error').inner_text())

    prov = page.evaluate("""() => new Promise(r => { const q = indexedDB.open('atode-mitsukaru'); q.onsuccess = () => { const g = q.result.transaction('items').objectStore('items').getAll(); g.onsuccess = () => r(g.result.flatMap(i => i.attachments.map(a => a.provenance + '/' + a.state + '/' + a.size))); }; })""")
    check('写真はPDF内のJPEGをそのまま保存（描き直しなし）', sum(x.startswith('listpdf-identical/saved') for x in prov) == 4 and sorted(int(x.split('/')[2]) for x in prov if x.startswith('listpdf'))== sorted(len(i) for i in IMGS), str(prov))
    ext = [u for u in requests if not u.startswith(URL) and not u.startswith('blob:') and not u.startswith('data:')]
    check('外部への通信なし', not ext, str(ext[:3]))
    check('画面のエラーなし', not errors, str(errors[:3]))
    shot('l10_home_final')
    page.emulate_media(color_scheme='dark'); page.locator('.entry', has_text='給食').first.click(); shot('l11_dark_detail'); page.get_by_role('button', name='戻る').click(); shot('l12_dark_home')
    b.close()

bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} 合格')
sys.exit(1 if bad else 0)
