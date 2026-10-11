# Third-party data and software

NatsuRoute's own code is MIT-licensed. The data and libraries below belong
to their owners and are used under the terms listed. This is a summary, not
legal advice; read each source's terms before redistributing anything
derived from it.

## Data

- **公共交通オープンデータセンター (ODPT)**: train and bus timetables,
  stations, bus stops, fares, train types, live train information and train
  positions. Apps must show when dynamic data was generated, and NatsuRoute
  shows the time of each live status and delay. https://www.odpt.org/
  - **ODPT Challenge 2026 data** (JR East, Tokyu, Odakyu, Keio, Seibu, Tobu,
    Keikyu, Sotetsu, Kokusai Kogyo Bus and others) is licensed for the
    Challenge entry only and may not be redistributed. NatsuRoute keeps it on
    the server and never commits it: `data/` is git-ignored.
- **3D都市モデル（Project PLATEAU）, 国土交通省**: building, vegetation,
  bridge and city-furniture models for the 23 wards, reduced to outlines and
  heights for the shade engine (processed). CC BY 4.0.
  https://www.mlit.go.jp/plateau/
- **歩行空間ネットワークデータ, 国土交通省 歩行空間ナビ・データプラットフォーム
  (ほこナビDP)**: roofs, underground passages, corridors, stairs, lifts,
  slopes and kerbs around 13 station areas, merged into the walking network
  (processed). 公共データ利用規約（第1.0版）. https://www.hokonavi.go.jp/
- **OpenStreetMap**: the walking network, street names, trees, station
  entrances, bus-stop shelters, toilets, drinking water, benches and other
  points. © OpenStreetMap contributors, ODbL 1.0.
  https://www.openstreetmap.org/copyright
- **暑さ指数（WBGT）・熱中症警戒アラート, 環境省 熱中症予防情報サイト**:
  forecasts, hourly estimates and alerts. https://www.wbgt.env.go.jp/
- **クーリングシェルター・TOKYOクールシェアスポット, 東京都 熱中症対策ポータル**:
  the list of cooling shelters and cool-share spots (geocoded, processed).
  https://wbgt.metro.tokyo.lg.jp/
- **国土地理院 (GSI) address search and reverse geocoder**: places for
  shelter addresses and the "current location" name.
  https://msearch.gsi.go.jp/ , https://mreversegeocoder.gsi.go.jp/
- **国土数値情報（鉄道データ）N02, 国土交通省**: track alignment and
  positions for stations ODPT publishes without coordinates.
  https://nlftp.mlit.go.jp/ksj/
- **holidays-jp**: Japanese public holidays. https://holidays-jp.github.io/
- **OpenFreeMap / OpenMapTiles / OpenStreetMap**: basemap tiles, styles and
  fonts. © OpenMapTiles, data © OpenStreetMap contributors (ODbL).
  https://openfreemap.org/

## Software

- React and React DOM: MIT
- MapLibre GL JS: BSD-3-Clause
- Hono and @hono/node-server: MIT
- stream-json, yauzl: BSD-3-Clause, MIT
- Vite, Vitest, esbuild, tsx, TypeScript, Playwright: MIT / Apache-2.0
- BIZ UDPGothic (Morisawa, via @fontsource/biz-udpgothic): SIL Open Font
  License 1.1
- Python: numpy (BSD-3-Clause), shapely (BSD-3-Clause), pyosmium
  (BSD-2-Clause), scipy (BSD-3-Clause)
