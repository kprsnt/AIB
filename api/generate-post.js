// Import necessary libraries
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Octokit } = require('@octokit/rest');
const { createHmac } = require('crypto');
require('dotenv').config();

// Initialize clients
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// GitHub repository details from environment variables
const owner = process.env.GITHUB_REPO_OWNER;
const repo = process.env.GITHUB_REPO_NAME;
const webhookSecret = process.env.WEBHOOK_SECRET;

// Main serverless function handler
module.exports = async (req, res) => {
    // 1. Verify the webhook signature
    const signature = req.headers['x-hub-signature-256'];
    const hmac = createHmac('sha256', webhookSecret);
    hmac.update(JSON.stringify(req.body));
    const calculatedSignature = `sha256=${hmac.digest('hex')}`;

    if (signature !== calculatedSignature) {
        console.error('Webhook signature does not match.');
        return res.status(401).send('Unauthorized');
    }

    // Only proceed for pushes to the main branch (or master)
    if (req.body.ref !== 'refs/heads/main' && req.body.ref !== 'refs/heads/master') {
        return res.status(200).send('Push was not to the main branch, skipping.');
    }

    try {
        // Core logic will go here
        console.log('Webhook received and verified. Starting post generation...');

        // Get the SHA of the latest commit on the main branch
        const { data: refData } = await octokit.git.getRef({
            owner,
            repo,
            ref: 'heads/main', // or 'heads/master'
        });
        const latestCommitSha = refData.object.sha;

        // Get the content of ideas.md
        const { data: ideasFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'ideas.md',
            ref: latestCommitSha,
        });
        const ideasContent = Buffer.from(ideasFile.content, 'base64').toString('utf8');

        // Get the list of existing posts
        const { data: existingPosts } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'public/posts',
            ref: latestCommitSha,
        });
        const existingPostFiles = existingPosts.map(file => file.name);

        // Parse ideas and identify new ones
        const newIdeas = parseIdeas(ideasContent, existingPostFiles);

        if (newIdeas.length === 0) {
            console.log('No new ideas to process.');
            return res.status(200).send('No new ideas found.');
        }

        console.log(`Found ${newIdeas.length} new ideas to process.`);

        // An array to hold all the file creation promises
        const newFilesToCommit = [];

        // Fetch the post template
        const { data: templateFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'templates/post-template.html',
            ref: latestCommitSha,
        });
        const postTemplate = Buffer.from(templateFile.content, 'base64').toString('utf8');


        // Generate a post for each new idea
        for (const idea of newIdeas) {
            console.log(`Generating post for: ${idea.topic}`);
            const prompt = `You are an expert blog writer who writes clear, engaging, and well-structured technical and general interest articles.

Your task is to convert the following topic and analysis points into a complete blog post.

The output format MUST be clean, semantic HTML. Do not include \`<html>\`, \`<head>\`, or \`<body>\` tags. Only provide the article content itself, starting with an \`<h1>\` for the title. Use \`<p>\`, \`<h2>\`, \`<h3>\`, \`<ul>\`, \`<li>\`, and \`<strong>\` tags appropriately to structure the article.

**Topic:**
${idea.topic}

**Analysis & Key Points to Include:**
${idea.analysis}

Generate the HTML content for the blog post now.`;

            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const generatedHtml = response.text();

            // Create the full HTML for the new post
            const postContent = postTemplate
                .replace('{{POST_TITLE}}', idea.topic)
                .replace('{{POST_CONTENT}}', generatedHtml);

            newFilesToCommit.push({
                path: `public/posts/${idea.filename}`,
                content: postContent,
            });
        }

        // If there are no new files to commit, we can stop.
        if (newFilesToCommit.length === 0) {
            return res.status(200).send('No new posts were generated.');
        }

        // Update index.html
        const { data: updatedPosts } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'public/posts',
            ref: latestCommitSha, // Get the list again in case it changed
        });

        const allPostFiles = [...updatedPosts.map(p => p.name), ...newIdeas.map(i => i.filename)];
        const uniquePostFiles = [...new Set(allPostFiles)]; // Ensure uniqueness

        const postLinks = uniquePostFiles
            .map(filename => `<li><a href="posts/${filename}">${filename.replace('.html', '').replace(/-/g, ' ')}</a></li>`)
            .join('\n');

        const { data: indexFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'public/index.html',
            ref: latestCommitSha,
        });
        const indexContent = Buffer.from(indexFile.content, 'base64').toString('utf8');
        const updatedIndexContent = indexContent.replace('<!-- POSTS_LIST -->', `<ul>\n${postLinks}\n</ul>`);

        newFilesToCommit.push({
            path: 'public/index.html',
            content: updatedIndexContent,
        });

        // Commit the new files to the repository
        const { data: latestCommit } = await octokit.git.getCommit({
            owner,
            repo,
            commit_sha: latestCommitSha,
        });
        const baseTreeSha = latestCommit.tree.sha;

        const blobs = await Promise.all(
            newFilesToCommit.map(file =>
                octokit.git.createBlob({
                    owner,
                    repo,
                    content: file.content,
                    encoding: 'utf-8',
                }).then(blob => ({
                    path: file.path,
                    mode: '100644',
                    type: 'blob',
                    sha: blob.data.sha,
                }))
            )
        );

        const { data: newTree } = await octokit.git.createTree({
            owner,
            repo,
            base_tree: baseTreeSha,
            tree: blobs,
        });

        const { data: newCommit } = await octokit.git.createCommit({
            owner,
            repo,
            message: 'feat: Add new blog posts from ideas.md',
            tree: newTree.sha,
            parents: [latestCommitSha],
        });

        await octokit.git.updateRef({
            owner,
            repo,
            ref: 'heads/main', // or 'heads/master'
            sha: newCommit.sha,
        });

        console.log('Successfully committed new posts.');
        res.status(200).send('Processing completed. New posts added.');
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Internal Server Error');
    }
};

function slugify(text) {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start of text
        .replace(/-+$/, '');            // Trim - from end of text
}

function parseIdeas(content, existingPostFiles) {
    const ideas = content.split('---').filter(idea => idea.trim() !== '');
    const newIdeas = [];

    for (const idea of ideas) {
        const topicMatch = idea.match(/TOPIC:\s*(.*)/);
        const analysisMatch = idea.match(/ANALYSIS:\s*([\s\S]*)/);

        if (topicMatch && topicMatch[1]) {
            const topic = topicMatch[1].trim();
            const analysis = analysisMatch ? analysisMatch[1].trim() : '';
            const filename = `${slugify(topic)}.html`;

            if (!existingPostFiles.includes(filename)) {
                newIdeas.push({ topic, analysis, filename });
            }
        }
    }

    return newIdeas;
}
