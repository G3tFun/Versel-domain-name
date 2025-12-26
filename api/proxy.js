const cheerio = require('cheerio'); // Импортируем cheerio

module.exports = async (req, res) => {
    const { url: targetUrl } = req.query; // Изменил имя переменной для ясности

    if (!targetUrl) {
        return res.status(400).send('URL parameter is required.');
    }

    try {
        const response = await fetch(targetUrl);

        if (!response.ok) {
            return res.status(response.status).send(`Failed to fetch: ${response.statusText}`);
        }

        const contentType = response.headers.get('Content-Type') || 'text/html';
        let content = await response.text();

        // Только для HTML контента пытаемся перезаписывать ссылки
        if (contentType.includes('text/html')) {
            const $ = cheerio.load(content); // Загружаем HTML в Cheerio

            // Перезаписываем ссылки <a>
            $('a').each((i, link) => {
                const href = $(link).attr('href');
                if (href) {
                    const absoluteHref = new URL(href, targetUrl).href; // Преобразуем в абсолютный URL
                    $(link).attr('href', `/api/proxy?url=${encodeURIComponent(absoluteHref)}`);
                }
            });

            // !!! ВНИМАНИЕ: Это минимальный пример.
            // Вам нужно будет переписать гораздо больше:
            // - src атрибуты (img, script, link[rel="stylesheet"])
            // - action атрибуты (form)
            // - background-image в CSS
            // - JavaScript, который динамически создает ссылки или делает fetch-запросы
            // Это очень сложная задача!

            content = $.html(); // Получаем измененный HTML
        }


        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType);
        res.send(content);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('Error proxying request.');
    }
};
