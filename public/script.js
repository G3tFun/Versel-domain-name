// public/script.js
const urlInput = document.getElementById('urlInput');
const goButton = document.getElementById('goButton');
const contentFrame = document.getElementById('contentFrame');

const PROXY_URL = '/api/proxy'; // Путь к вашей Serverless-функции на Vercel

async function loadContent(targetUrl) {
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl; // Добавляем HTTPS по умолчанию
    }
    urlInput.value = targetUrl; // Обновляем адресную строку

    try {
        // Вызываем нашу Serverless-функцию проксирования
        const response = await fetch(`${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`);

        if (!response.ok) {
            const errorText = await response.text();
            contentFrame.srcdoc = `<p style="color: red; padding: 20px;">Ошибка загрузки: ${response.status} - ${errorText}</p>`;
            return;
        }

        const htmlContent = await response.text();
        
        // Вставляем полученный HTML в srcdoc iframe
        // Это обходит SOP, так как контент пришел с того же домена (вашего прокси)
        // Но есть нюансы с относительными путями и скриптами!
        contentFrame.srcdoc = htmlContent;

    } catch (error) {
        console.error('Произошла ошибка:', error);
        contentFrame.srcdoc = `<p style="color: red; padding: 20px;">Не удалось загрузить страницу: ${error.message}</p>`;
    }
}

goButton.addEventListener('click', () => {
    loadContent(urlInput.value);
});

// Загружаем начальный URL при старте
document.addEventListener('DOMContentLoaded', () => {
    loadContent(urlInput.value);
});
