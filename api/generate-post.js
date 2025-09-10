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
    console.log('Received a request to /api/generate-post');

    // 1. Verify the webhook signature
    // This is a security measure to ensure that the request is coming from GitHub.
    // Make sure the WEBHOOK_SECRET environment variable is set correctly in your deployment.
    try {
        const signature = req.headers['x-hub-signature-256'];
        if (!signature) {
            console.error('Signature missing from request.');
            return res.status(401).send('Unauthorized: Signature missing.');
        }

        const hmac = createHmac('sha256', webhookSecret);
        hmac.update(JSON.stringify(req.body));
        const calculatedSignature = `sha256=${hmac.digest('hex')}`;

        if (signature !== calculatedSignature) {
            console.error('Webhook signature does not match. Check your WEBHOOK_SECRET.');
            return res.status(401).send('Unauthorized: Invalid signature.');
        }
        console.log('Webhook signature verified successfully.');
    } catch (error) {
        console.error('Error during webhook signature verification:', error);
        return res.status(500).send('Internal Server Error during verification.');
    }


    // 2. Check the push event and determine branch
    const pushRef = req.body.ref; // e.g., 'refs/heads/main'
    console.log(`Push event for ref: ${pushRef}`);

    if (!pushRef || !pushRef.startsWith('refs/heads/')) {
        console.log('Push event was not for a branch, skipping.');
        return res.status(200).send('Push was not a branch push, skipping.');
    }
    const branchName = pushRef.substring('refs/heads/'.length);
    const branchRef = `heads/${branchName}`;
    console.log(`Processing push to branch: ${branchName}`);


    try {
        console.log('Starting post generation process...');

        // 3. Get the SHA of the latest commit
        const { data: refData } = await octokit.git.getRef({
            owner,
            repo,
            ref: branchRef,
        });
        const latestCommitSha = refData.object.sha;
        console.log(`Latest commit SHA on main branch is: ${latestCommitSha}`);

        // 4. Fetch and parse ideas.md
        let ideasContent;
        try {
            console.log('Fetching ideas.md...');
            const { data: ideasFile } = await octokit.repos.getContent({
                owner,
                repo,
                path: 'ideas.md',
                ref: latestCommitSha,
            });
            ideasContent = Buffer.from(ideasFile.content, 'base64').toString('utf8');
            console.log(`Successfully fetched ideas.md (length: ${ideasContent.length}).`);
        } catch (error) {
            if (error.status === 404) {
                console.log('ideas.md not found in the repository. Nothing to do.');
                return res.status(200).send('ideas.md not found. No new ideas to process.');
            }
            console.error('Failed to fetch ideas.md:', error);
            throw new Error('Could not retrieve ideas.md from the repository.');
        }


        // 5. Fetch existing posts
        let existingPostFiles = [];
        try {
            console.log('Fetching existing posts from public/posts...');
            const { data: existingPosts } = await octokit.repos.getContent({
                owner,
                repo,
                path: 'public/posts',
                ref: latestCommitSha,
            });
            existingPostFiles = existingPosts.map(file => file.name);
            console.log(`Found ${existingPostFiles.length} existing posts:`, existingPostFiles);
        } catch (error) {
            if (error.status === 404) {
                console.log('The public/posts directory does not exist yet. Assuming no posts exist.');
                existingPostFiles = []; // Directory doesn't exist, so no posts
            } else {
                console.error('Failed to fetch existing posts:', error);
                throw new Error('Could not retrieve existing posts from the repository.');
            }
        }

        // 6. Parse ideas and identify new ones
        const newIdeas = parseIdeas(ideasContent, existingPostFiles);
        if (newIdeas.length === 0) {
            console.log('No new ideas to process.');
            return res.status(200).send('No new ideas found.');
        }
        console.log(`Found ${newIdeas.length} new ideas to process:`, newIdeas.map(i => i.topic));

        // 7. Generate posts for new ideas
        const newFilesToCommit = [];
        const { data: templateFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'templates/post-template.html',
            ref: latestCommitSha,
        });
        const postTemplate = Buffer.from(templateFile.content, 'base64').toString('utf8');
        console.log('Post template fetched successfully.');

        for (const idea of newIdeas) {
            console.log(`--- Generating content for: "${idea.topic}" ---`);
            const prompt = `
                You are an expert technical blog writer specializing in clear, engaging, and informative content.
                Your response must be the raw HTML content for the blog post body. Do not include <html>, <head>, or <body> tags.
                The topic for this blog post is: "${idea.topic}".
                Use the following analysis to guide your writing:
                ${idea.analysis}
            `;

            let generatedHtml;
            try {
                console.log(`Calling Gemini API for topic: "${idea.topic}"`);
                const model = genAI.getGenerativeModel({ model: "gemini-pro" });
                const result = await model.generateContent(prompt);
                const response = await result.response;
                generatedHtml = response.text();
                console.log(`Successfully generated content for "${idea.topic}"`);
            } catch (error) {
                console.error(`Failed to generate content for topic "${idea.topic}". Error: ${error.message}`);
                console.error(`Skipping this idea and continuing with the next one.`);
                continue; // Skip to the next idea
            }

            const postContent = postTemplate
                .replace('{{POST_TITLE}}', idea.topic)
                .replace('{{POST_CONTENT}}', generatedHtml);

            newFilesToCommit.push({
                path: `public/posts/${idea.filename}`,
                content: postContent,
            });
            console.log(`Created content for ${idea.filename}`);
        }

        if (newFilesToCommit.length === 0) {
            console.log('Although there were new ideas, no files were generated to commit.');
            return res.status(200).send('No new posts were generated.');
        }

        // 8. Update index.html
        console.log('Updating index.html...');
        const allPostFiles = [...existingPostFiles, ...newIdeas.map(i => i.filename)];
        const uniquePostFiles = [...new Set(allPostFiles)];
        const postLinks = uniquePostFiles
            .sort() // Sort alphabetically for consistent order
            .map(filename => {
                const title = filename.replace('.html', '').replace(/-/g, ' ');
                return `<li><a href="posts/${filename}">${title}</a></li>`;
            })
            .join('\n');

        const { data: indexFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'public/index.html',
            ref: latestCommitSha,
        });
        const indexContent = Buffer.from(indexFile.content, 'base64').toString('utf8');
        // Use a more robust regex to replace the content, in case the list is already there.
        const updatedIndexContent = indexContent.replace(/<ul>[\s\S]*<\/ul>|<!-- POSTS_LIST -->/, `<ul>\n${postLinks}\n</ul>`);

        newFilesToCommit.push({
            path: 'public/index.html',
            content: updatedIndexContent,
        });
        console.log('index.html updated and added to commit list.');
        console.log(`${newFilesToCommit.length} files are ready to be committed.`);

        // 9. Commit new files to GitHub
        try {
            console.log('Starting commit process...');
            const { data: latestCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
            const baseTreeSha = latestCommit.tree.sha;
            console.log(`Base tree SHA: ${baseTreeSha}`);

            const blobs = await Promise.all(
                newFilesToCommit.map(file =>
                    octokit.git.createBlob({ owner, repo, content: file.content, encoding: 'utf-8' })
                        .then(blob => {
                            console.log(`Blob created for ${file.path} (SHA: ${blob.data.sha})`);
                            return { path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha };
                        })
                )
            );

            const { data: newTree } = await octokit.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: blobs });
            console.log(`New tree created (SHA: ${newTree.sha})`);

            const { data: newCommit } = await octokit.git.createCommit({
                owner,
                repo,
                message: 'feat: Add new blog posts from ideas.md',
                tree: newTree.sha,
                parents: [latestCommitSha],
            });
            console.log(`New commit created (SHA: ${newCommit.sha})`);

            await octokit.git.updateRef({ owner, repo, ref: branchRef, sha: newCommit.sha });
            console.log(`Successfully updated ref for ${branchRef}.`);
        } catch (error) {
            console.error('Failed to commit new files to GitHub:', error);
            throw new Error('Could not commit new files to the repository.');
        }

        console.log('--- Post generation process completed successfully! ---');
        res.status(200).send('Processing completed. New posts added.');

    } catch (error) {
        console.error('--- An error occurred during the post generation process ---');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        if (error.response) {
            console.error('Error response data:', error.response.data);
        }
        res.status(500).send('Internal Server Error');
    }
};

// Helper function to convert a string into a URL-friendly slug
function slugify(text) {
    return text.toString().toLowerCase().trim()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start of text
        .replace(/-+$/, '');            // Trim - from end of text
}

// Helper function to parse the ideas from ideas.md
function parseIdeas(content, existingPostFiles) {
    const ideas = content.split('---').filter(idea => idea.trim() !== '');
    const newIdeas = [];
    for (const idea of ideas) {
        const topicMatch = idea.match(/TOPIC:\s*(.*)/i); // Case-insensitive
        const analysisMatch = idea.match(/ANALYSIS:\s*([\s\S]*)/i); // Case-insensitive
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
