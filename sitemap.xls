<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet
  version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">

  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/">
    <html>
      <head>
        <title>Artistic DK | XML Sitemap</title>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 40px 20px;
            background: #f5f1e9;
            color: #342c25;
            font-family: Arial, sans-serif;
          }
          .container {
            max-width: 850px;
            margin: auto;
            background: #fff;
            padding: 35px;
            border-radius: 16px;
            box-shadow: 0 8px 30px rgba(0,0,0,.06);
          }
          h1 { margin-top: 0; color: #75543c; }
          .subtitle { color: #887b70; margin-bottom: 28px; }
          .url {
            padding: 18px;
            border: 1px solid #eee6dc;
            border-radius: 10px;
            margin: 12px 0;
            overflow-wrap: anywhere;
          }
          a { color: #936b47; text-decoration: none; }
          a:hover { text-decoration: underline; }
          .priority { color: #8b8177; font-size: 13px; margin-top: 7px; }
          .count { color: #75543c; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Artistic DK</h1>
          <p class="subtitle">Official XML Sitemap · Search engine discovery</p>
          <p class="count">
            <xsl:value-of select="count(s:urlset/s:url)"/> pages listed
          </p>
          <xsl:for-each select="s:urlset/s:url">
            <div class="url">
              <a href="{s:loc}">
                <xsl:value-of select="s:loc"/>
              </a>
              <div class="priority">
                Priority: <xsl:value-of select="s:priority"/>
              </div>
            </div>
          </xsl:for-each>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
